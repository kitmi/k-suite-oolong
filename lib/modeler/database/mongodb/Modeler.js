"use strict";

require("source-map-support/register");

const path = require('path');

const Util = require('rk-utils');

const {
  _,
  fs,
  quote
} = Util;

const OolUtils = require('../../../lang/OolUtils');

const Types = require('../../../runtime/types');

class MongoDbModeler {
  constructor(context, connector, dbOptions) {
    this.logger = context.logger;
    this.linker = context.linker;
    this.outputPath = context.scriptOutputPath;
    this.connector = connector;
  }

  modeling(schema) {
    let dataFilesDir = path.join('mongodb', this.connector.database);
    let initIdxFilePath = path.join(dataFilesDir, 'data', '_init', 'index.list');
    let initFilePath = path.join(dataFilesDir, 'data', '_init', '0-init.json');

    this._writeFile(path.join(this.outputPath, initFilePath), JSON.stringify({}, null, 4));

    if (!fs.existsSync(path.join(this.outputPath, initIdxFilePath))) {
      this._writeFile(path.join(this.outputPath, initIdxFilePath), '0-init.json\n');
    }

    return schema;
  }

  _writeFile(filePath, content) {
    fs.ensureFileSync(filePath);
    fs.writeFileSync(filePath, content);
    this.logger.log('info', 'Generated db script: ' + filePath);
  }

}

module.exports = MongoDbModeler;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9tb2RlbGVyL2RhdGFiYXNlL21vbmdvZGIvTW9kZWxlci5qcyJdLCJuYW1lcyI6WyJwYXRoIiwicmVxdWlyZSIsIlV0aWwiLCJfIiwiZnMiLCJxdW90ZSIsIk9vbFV0aWxzIiwiVHlwZXMiLCJNb25nb0RiTW9kZWxlciIsImNvbnN0cnVjdG9yIiwiY29udGV4dCIsImNvbm5lY3RvciIsImRiT3B0aW9ucyIsImxvZ2dlciIsImxpbmtlciIsIm91dHB1dFBhdGgiLCJzY3JpcHRPdXRwdXRQYXRoIiwibW9kZWxpbmciLCJzY2hlbWEiLCJkYXRhRmlsZXNEaXIiLCJqb2luIiwiZGF0YWJhc2UiLCJpbml0SWR4RmlsZVBhdGgiLCJpbml0RmlsZVBhdGgiLCJfd3JpdGVGaWxlIiwiSlNPTiIsInN0cmluZ2lmeSIsImV4aXN0c1N5bmMiLCJmaWxlUGF0aCIsImNvbnRlbnQiLCJlbnN1cmVGaWxlU3luYyIsIndyaXRlRmlsZVN5bmMiLCJsb2ciLCJtb2R1bGUiLCJleHBvcnRzIl0sIm1hcHBpbmdzIjoiQUFBQTs7OztBQUVBLE1BQU1BLElBQUksR0FBR0MsT0FBTyxDQUFDLE1BQUQsQ0FBcEI7O0FBQ0EsTUFBTUMsSUFBSSxHQUFHRCxPQUFPLENBQUMsVUFBRCxDQUFwQjs7QUFDQSxNQUFNO0FBQUVFLEVBQUFBLENBQUY7QUFBS0MsRUFBQUEsRUFBTDtBQUFTQyxFQUFBQTtBQUFULElBQW1CSCxJQUF6Qjs7QUFFQSxNQUFNSSxRQUFRLEdBQUdMLE9BQU8sQ0FBQyx3QkFBRCxDQUF4Qjs7QUFDQSxNQUFNTSxLQUFLLEdBQUdOLE9BQU8sQ0FBQyx3QkFBRCxDQUFyQjs7QUFNQSxNQUFNTyxjQUFOLENBQXFCO0FBVWpCQyxFQUFBQSxXQUFXLENBQUNDLE9BQUQsRUFBVUMsU0FBVixFQUFxQkMsU0FBckIsRUFBZ0M7QUFDdkMsU0FBS0MsTUFBTCxHQUFjSCxPQUFPLENBQUNHLE1BQXRCO0FBQ0EsU0FBS0MsTUFBTCxHQUFjSixPQUFPLENBQUNJLE1BQXRCO0FBQ0EsU0FBS0MsVUFBTCxHQUFrQkwsT0FBTyxDQUFDTSxnQkFBMUI7QUFDQSxTQUFLTCxTQUFMLEdBQWlCQSxTQUFqQjtBQUdIOztBQUVETSxFQUFBQSxRQUFRLENBQUNDLE1BQUQsRUFBUztBQUNiLFFBQUlDLFlBQVksR0FBR25CLElBQUksQ0FBQ29CLElBQUwsQ0FBVSxTQUFWLEVBQXFCLEtBQUtULFNBQUwsQ0FBZVUsUUFBcEMsQ0FBbkI7QUFFQSxRQUFJQyxlQUFlLEdBQUd0QixJQUFJLENBQUNvQixJQUFMLENBQVVELFlBQVYsRUFBd0IsTUFBeEIsRUFBZ0MsT0FBaEMsRUFBeUMsWUFBekMsQ0FBdEI7QUFDQSxRQUFJSSxZQUFZLEdBQUd2QixJQUFJLENBQUNvQixJQUFMLENBQVVELFlBQVYsRUFBd0IsTUFBeEIsRUFBZ0MsT0FBaEMsRUFBeUMsYUFBekMsQ0FBbkI7O0FBRUEsU0FBS0ssVUFBTCxDQUFnQnhCLElBQUksQ0FBQ29CLElBQUwsQ0FBVSxLQUFLTCxVQUFmLEVBQTJCUSxZQUEzQixDQUFoQixFQUEwREUsSUFBSSxDQUFDQyxTQUFMLENBQWUsRUFBZixFQUFtQixJQUFuQixFQUF5QixDQUF6QixDQUExRDs7QUFFQSxRQUFJLENBQUN0QixFQUFFLENBQUN1QixVQUFILENBQWMzQixJQUFJLENBQUNvQixJQUFMLENBQVUsS0FBS0wsVUFBZixFQUEyQk8sZUFBM0IsQ0FBZCxDQUFMLEVBQWlFO0FBQzdELFdBQUtFLFVBQUwsQ0FBZ0J4QixJQUFJLENBQUNvQixJQUFMLENBQVUsS0FBS0wsVUFBZixFQUEyQk8sZUFBM0IsQ0FBaEIsRUFBNkQsZUFBN0Q7QUFDSDs7QUFFRCxXQUFPSixNQUFQO0FBQ0g7O0FBRURNLEVBQUFBLFVBQVUsQ0FBQ0ksUUFBRCxFQUFXQyxPQUFYLEVBQW9CO0FBQzFCekIsSUFBQUEsRUFBRSxDQUFDMEIsY0FBSCxDQUFrQkYsUUFBbEI7QUFDQXhCLElBQUFBLEVBQUUsQ0FBQzJCLGFBQUgsQ0FBaUJILFFBQWpCLEVBQTJCQyxPQUEzQjtBQUVBLFNBQUtoQixNQUFMLENBQVltQixHQUFaLENBQWdCLE1BQWhCLEVBQXdCLDBCQUEwQkosUUFBbEQ7QUFDSDs7QUF2Q2dCOztBQTBDckJLLE1BQU0sQ0FBQ0MsT0FBUCxHQUFpQjFCLGNBQWpCIiwic291cmNlc0NvbnRlbnQiOlsiXCJ1c2Ugc3RyaWN0XCI7XG5cbmNvbnN0IHBhdGggPSByZXF1aXJlKCdwYXRoJyk7XG5jb25zdCBVdGlsID0gcmVxdWlyZSgncmstdXRpbHMnKTtcbmNvbnN0IHsgXywgZnMsIHF1b3RlIH0gPSBVdGlsO1xuXG5jb25zdCBPb2xVdGlscyA9IHJlcXVpcmUoJy4uLy4uLy4uL2xhbmcvT29sVXRpbHMnKTtcbmNvbnN0IFR5cGVzID0gcmVxdWlyZSgnLi4vLi4vLi4vcnVudGltZS90eXBlcycpO1xuXG4vKipcbiAqIE9vb2xvbmcgZGF0YWJhc2UgbW9kZWxlciBmb3IgbW9uZ29kYi5cbiAqIEBjbGFzc1xuICovXG5jbGFzcyBNb25nb0RiTW9kZWxlciB7XG4gICAgLyoqICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gY29udGV4dFxuICAgICAqIEBwcm9wZXJ0eSB7TG9nZ2VyfSBjb250ZXh0LmxvZ2dlciAtIExvZ2dlciBvYmplY3QgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7T29sb25nTGlua2VyfSBjb250ZXh0LmxpbmtlciAtIE9vbG9uZyBEU0wgbGlua2VyXG4gICAgICogQHByb3BlcnR5IHtzdHJpbmd9IGNvbnRleHQuc2NyaXB0T3V0cHV0UGF0aCAtIEdlbmVyYXRlZCBzY3JpcHQgcGF0aFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYk9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gZGJPcHRpb25zLmRiXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IGRiT3B0aW9ucy50YWJsZVxuICAgICAqL1xuICAgIGNvbnN0cnVjdG9yKGNvbnRleHQsIGNvbm5lY3RvciwgZGJPcHRpb25zKSB7XG4gICAgICAgIHRoaXMubG9nZ2VyID0gY29udGV4dC5sb2dnZXI7XG4gICAgICAgIHRoaXMubGlua2VyID0gY29udGV4dC5saW5rZXI7XG4gICAgICAgIHRoaXMub3V0cHV0UGF0aCA9IGNvbnRleHQuc2NyaXB0T3V0cHV0UGF0aDtcbiAgICAgICAgdGhpcy5jb25uZWN0b3IgPSBjb25uZWN0b3I7XG5cbiAgICAgICAgXG4gICAgfVxuXG4gICAgbW9kZWxpbmcoc2NoZW1hKSB7XG4gICAgICAgIGxldCBkYXRhRmlsZXNEaXIgPSBwYXRoLmpvaW4oJ21vbmdvZGInLCB0aGlzLmNvbm5lY3Rvci5kYXRhYmFzZSk7XG5cbiAgICAgICAgbGV0IGluaXRJZHhGaWxlUGF0aCA9IHBhdGguam9pbihkYXRhRmlsZXNEaXIsICdkYXRhJywgJ19pbml0JywgJ2luZGV4Lmxpc3QnKTtcbiAgICAgICAgbGV0IGluaXRGaWxlUGF0aCA9IHBhdGguam9pbihkYXRhRmlsZXNEaXIsICdkYXRhJywgJ19pbml0JywgJzAtaW5pdC5qc29uJyk7XG5cbiAgICAgICAgdGhpcy5fd3JpdGVGaWxlKHBhdGguam9pbih0aGlzLm91dHB1dFBhdGgsIGluaXRGaWxlUGF0aCksIEpTT04uc3RyaW5naWZ5KHt9LCBudWxsLCA0KSk7XG5cbiAgICAgICAgaWYgKCFmcy5leGlzdHNTeW5jKHBhdGguam9pbih0aGlzLm91dHB1dFBhdGgsIGluaXRJZHhGaWxlUGF0aCkpKSB7XG4gICAgICAgICAgICB0aGlzLl93cml0ZUZpbGUocGF0aC5qb2luKHRoaXMub3V0cHV0UGF0aCwgaW5pdElkeEZpbGVQYXRoKSwgJzAtaW5pdC5qc29uXFxuJyk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gc2NoZW1hO1xuICAgIH0gICAgXG5cbiAgICBfd3JpdGVGaWxlKGZpbGVQYXRoLCBjb250ZW50KSB7XG4gICAgICAgIGZzLmVuc3VyZUZpbGVTeW5jKGZpbGVQYXRoKTtcbiAgICAgICAgZnMud3JpdGVGaWxlU3luYyhmaWxlUGF0aCwgY29udGVudCk7XG5cbiAgICAgICAgdGhpcy5sb2dnZXIubG9nKCdpbmZvJywgJ0dlbmVyYXRlZCBkYiBzY3JpcHQ6ICcgKyBmaWxlUGF0aCk7XG4gICAgfVxufVxuXG5tb2R1bGUuZXhwb3J0cyA9IE1vbmdvRGJNb2RlbGVyOyJdfQ==