"use strict";

require("source-map-support/register");

const {
  _
} = require('rk-utils');

const SupportedDrivers = ['mysql', 'mongodb', 'rabbitmq'];
const JsPrimitiveTypes = new Set(['number', 'boolean', 'string', 'symbol', 'undefined']);

function mergeCondition(condition1, condition2, operator = '$and') {
  if (_.isEmpty(condition1)) {
    return condition2;
  }

  if (_.isEmpty(condition2)) {
    return condition1;
  }

  return {
    [operator]: [condition1, condition2]
  };
}

exports.isNothing = v => _.isNil(v) || _.isNaN(v);

exports.isPrimitive = v => JsPrimitiveTypes.has(typeof v);

exports.isQuoted = s => (s.startsWith("'") || s.startsWith('"')) && s[0] === s[s.length - 1];

exports.isQuotedWith = (s, q) => s.startsWith(q) && s[0] === s[s.length - 1];

exports.makeDataSourceName = (driver, schema) => driver + '.' + schema;

exports.extractDriverAndConnectorName = id => id.split('.');

exports.mergeCondition = mergeCondition;
exports.SupportedDrivers = Object.freeze(SupportedDrivers);
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy91dGlscy9sYW5nLmpzIl0sIm5hbWVzIjpbIl8iLCJyZXF1aXJlIiwiU3VwcG9ydGVkRHJpdmVycyIsIkpzUHJpbWl0aXZlVHlwZXMiLCJTZXQiLCJtZXJnZUNvbmRpdGlvbiIsImNvbmRpdGlvbjEiLCJjb25kaXRpb24yIiwib3BlcmF0b3IiLCJpc0VtcHR5IiwiZXhwb3J0cyIsImlzTm90aGluZyIsInYiLCJpc05pbCIsImlzTmFOIiwiaXNQcmltaXRpdmUiLCJoYXMiLCJpc1F1b3RlZCIsInMiLCJzdGFydHNXaXRoIiwibGVuZ3RoIiwiaXNRdW90ZWRXaXRoIiwicSIsIm1ha2VEYXRhU291cmNlTmFtZSIsImRyaXZlciIsInNjaGVtYSIsImV4dHJhY3REcml2ZXJBbmRDb25uZWN0b3JOYW1lIiwiaWQiLCJzcGxpdCIsIk9iamVjdCIsImZyZWV6ZSJdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7QUFFQSxNQUFNO0FBQUVBLEVBQUFBO0FBQUYsSUFBUUMsT0FBTyxDQUFDLFVBQUQsQ0FBckI7O0FBRUEsTUFBTUMsZ0JBQWdCLEdBQUcsQ0FBRSxPQUFGLEVBQVcsU0FBWCxFQUFzQixVQUF0QixDQUF6QjtBQUNBLE1BQU1DLGdCQUFnQixHQUFHLElBQUlDLEdBQUosQ0FBUSxDQUFFLFFBQUYsRUFBWSxTQUFaLEVBQXVCLFFBQXZCLEVBQWlDLFFBQWpDLEVBQTJDLFdBQTNDLENBQVIsQ0FBekI7O0FBU0EsU0FBU0MsY0FBVCxDQUF3QkMsVUFBeEIsRUFBb0NDLFVBQXBDLEVBQWdEQyxRQUFRLEdBQUcsTUFBM0QsRUFBbUU7QUFDL0QsTUFBSVIsQ0FBQyxDQUFDUyxPQUFGLENBQVVILFVBQVYsQ0FBSixFQUEyQjtBQUN2QixXQUFPQyxVQUFQO0FBQ0g7O0FBRUQsTUFBSVAsQ0FBQyxDQUFDUyxPQUFGLENBQVVGLFVBQVYsQ0FBSixFQUEyQjtBQUN2QixXQUFPRCxVQUFQO0FBQ0g7O0FBRUQsU0FBTztBQUFFLEtBQUNFLFFBQUQsR0FBWSxDQUFFRixVQUFGLEVBQWNDLFVBQWQ7QUFBZCxHQUFQO0FBQ0g7O0FBRURHLE9BQU8sQ0FBQ0MsU0FBUixHQUFvQkMsQ0FBQyxJQUFJWixDQUFDLENBQUNhLEtBQUYsQ0FBUUQsQ0FBUixLQUFjWixDQUFDLENBQUNjLEtBQUYsQ0FBUUYsQ0FBUixDQUF2Qzs7QUFDQUYsT0FBTyxDQUFDSyxXQUFSLEdBQXNCSCxDQUFDLElBQUlULGdCQUFnQixDQUFDYSxHQUFqQixDQUFxQixPQUFPSixDQUE1QixDQUEzQjs7QUFDQUYsT0FBTyxDQUFDTyxRQUFSLEdBQW1CQyxDQUFDLElBQUksQ0FBQ0EsQ0FBQyxDQUFDQyxVQUFGLENBQWEsR0FBYixLQUFxQkQsQ0FBQyxDQUFDQyxVQUFGLENBQWEsR0FBYixDQUF0QixLQUE0Q0QsQ0FBQyxDQUFDLENBQUQsQ0FBRCxLQUFTQSxDQUFDLENBQUNBLENBQUMsQ0FBQ0UsTUFBRixHQUFTLENBQVYsQ0FBOUU7O0FBQ0FWLE9BQU8sQ0FBQ1csWUFBUixHQUF1QixDQUFDSCxDQUFELEVBQUlJLENBQUosS0FBV0osQ0FBQyxDQUFDQyxVQUFGLENBQWFHLENBQWIsS0FBbUJKLENBQUMsQ0FBQyxDQUFELENBQUQsS0FBU0EsQ0FBQyxDQUFDQSxDQUFDLENBQUNFLE1BQUYsR0FBUyxDQUFWLENBQS9EOztBQUNBVixPQUFPLENBQUNhLGtCQUFSLEdBQTZCLENBQUNDLE1BQUQsRUFBU0MsTUFBVCxLQUFxQkQsTUFBTSxHQUFHLEdBQVQsR0FBZUMsTUFBakU7O0FBQ0FmLE9BQU8sQ0FBQ2dCLDZCQUFSLEdBQXdDQyxFQUFFLElBQUlBLEVBQUUsQ0FBQ0MsS0FBSCxDQUFTLEdBQVQsQ0FBOUM7O0FBQ0FsQixPQUFPLENBQUNMLGNBQVIsR0FBeUJBLGNBQXpCO0FBQ0FLLE9BQU8sQ0FBQ1IsZ0JBQVIsR0FBMkIyQixNQUFNLENBQUNDLE1BQVAsQ0FBYzVCLGdCQUFkLENBQTNCIiwic291cmNlc0NvbnRlbnQiOlsiXCJ1c2Ugc3RyaWN0XCI7XG5cbmNvbnN0IHsgXyB9ID0gcmVxdWlyZSgncmstdXRpbHMnKTtcblxuY29uc3QgU3VwcG9ydGVkRHJpdmVycyA9IFsgJ215c3FsJywgJ21vbmdvZGInLCAncmFiYml0bXEnIF07XG5jb25zdCBKc1ByaW1pdGl2ZVR5cGVzID0gbmV3IFNldChbICdudW1iZXInLCAnYm9vbGVhbicsICdzdHJpbmcnLCAnc3ltYm9sJywgJ3VuZGVmaW5lZCcgXSk7XG5cbi8qKlxuICogTWVyZ2UgdHdvIHF1ZXJ5IGNvbmRpdGlvbnMgdXNpbmcgZ2l2ZW4gb3BlcmF0b3IuXG4gKiBAcGFyYW0geyp9IGNvbmRpdGlvbjEgXG4gKiBAcGFyYW0geyp9IGNvbmRpdGlvbjIgXG4gKiBAcGFyYW0geyp9IG9wZXJhdG9yIFxuICogQHJldHVybnMge29iamVjdH1cbiAqL1xuZnVuY3Rpb24gbWVyZ2VDb25kaXRpb24oY29uZGl0aW9uMSwgY29uZGl0aW9uMiwgb3BlcmF0b3IgPSAnJGFuZCcpIHsgICAgICAgIFxuICAgIGlmIChfLmlzRW1wdHkoY29uZGl0aW9uMSkpIHtcbiAgICAgICAgcmV0dXJuIGNvbmRpdGlvbjI7XG4gICAgfVxuXG4gICAgaWYgKF8uaXNFbXB0eShjb25kaXRpb24yKSkge1xuICAgICAgICByZXR1cm4gY29uZGl0aW9uMTtcbiAgICB9XG5cbiAgICByZXR1cm4geyBbb3BlcmF0b3JdOiBbIGNvbmRpdGlvbjEsIGNvbmRpdGlvbjIgXSB9O1xufVxuXG5leHBvcnRzLmlzTm90aGluZyA9IHYgPT4gXy5pc05pbCh2KSB8fCBfLmlzTmFOKHYpO1xuZXhwb3J0cy5pc1ByaW1pdGl2ZSA9IHYgPT4gSnNQcmltaXRpdmVUeXBlcy5oYXModHlwZW9mIHYpO1xuZXhwb3J0cy5pc1F1b3RlZCA9IHMgPT4gKHMuc3RhcnRzV2l0aChcIidcIikgfHwgcy5zdGFydHNXaXRoKCdcIicpKSAmJiBzWzBdID09PSBzW3MubGVuZ3RoLTFdO1xuZXhwb3J0cy5pc1F1b3RlZFdpdGggPSAocywgcSkgPT4gKHMuc3RhcnRzV2l0aChxKSAmJiBzWzBdID09PSBzW3MubGVuZ3RoLTFdKTtcbmV4cG9ydHMubWFrZURhdGFTb3VyY2VOYW1lID0gKGRyaXZlciwgc2NoZW1hKSA9PiAoZHJpdmVyICsgJy4nICsgc2NoZW1hKTtcbmV4cG9ydHMuZXh0cmFjdERyaXZlckFuZENvbm5lY3Rvck5hbWUgPSBpZCA9PiBpZC5zcGxpdCgnLicpO1xuZXhwb3J0cy5tZXJnZUNvbmRpdGlvbiA9IG1lcmdlQ29uZGl0aW9uO1xuZXhwb3J0cy5TdXBwb3J0ZWREcml2ZXJzID0gT2JqZWN0LmZyZWV6ZShTdXBwb3J0ZWREcml2ZXJzKTtcbiAiXX0=