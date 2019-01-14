"use strict";

require("source-map-support/register");

const _ = require('rk-utils')._;

const {
  isNothing
} = require('../../utils/lang');

const any = require('./any');

const {
  DataValidationError
} = require('../../runtime/Errors');

module.exports = {
  name: 'array',
  alias: ['list'],
  sanitize: (value, info, i18n) => {
    if (Array.isArray(value)) return value;

    if (typeof value === 'string') {
      let trimmed = value.trim();

      if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        return JSON.parse(trimmed);
      }

      throw new DataValidationError(`Invalid array format: ${value}`);
    }

    return [value];
  },
  defaultValue: [],
  generate: (info, i18n) => null,
  serialize: value => isNothing(value) ? null : JOSN.stringify(value),
  qualifiers: any.qualifiers.concat(['csv'])
};
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9ydW50aW1lL3R5cGVzL2FycmF5LmpzIl0sIm5hbWVzIjpbIl8iLCJyZXF1aXJlIiwiaXNOb3RoaW5nIiwiYW55IiwiRGF0YVZhbGlkYXRpb25FcnJvciIsIm1vZHVsZSIsImV4cG9ydHMiLCJuYW1lIiwiYWxpYXMiLCJzYW5pdGl6ZSIsInZhbHVlIiwiaW5mbyIsImkxOG4iLCJBcnJheSIsImlzQXJyYXkiLCJ0cmltbWVkIiwidHJpbSIsInN0YXJ0c1dpdGgiLCJlbmRzV2l0aCIsIkpTT04iLCJwYXJzZSIsImRlZmF1bHRWYWx1ZSIsImdlbmVyYXRlIiwic2VyaWFsaXplIiwiSk9TTiIsInN0cmluZ2lmeSIsInF1YWxpZmllcnMiLCJjb25jYXQiXSwibWFwcGluZ3MiOiJBQUFBOzs7O0FBRUEsTUFBTUEsQ0FBQyxHQUFHQyxPQUFPLENBQUMsVUFBRCxDQUFQLENBQW9CRCxDQUE5Qjs7QUFDQSxNQUFNO0FBQUVFLEVBQUFBO0FBQUYsSUFBZ0JELE9BQU8sQ0FBQyxrQkFBRCxDQUE3Qjs7QUFDQSxNQUFNRSxHQUFHLEdBQUdGLE9BQU8sQ0FBQyxPQUFELENBQW5COztBQUNBLE1BQU07QUFBRUcsRUFBQUE7QUFBRixJQUEwQkgsT0FBTyxDQUFDLHNCQUFELENBQXZDOztBQUVBSSxNQUFNLENBQUNDLE9BQVAsR0FBaUI7QUFDYkMsRUFBQUEsSUFBSSxFQUFFLE9BRE87QUFHYkMsRUFBQUEsS0FBSyxFQUFFLENBQUUsTUFBRixDQUhNO0FBS2JDLEVBQUFBLFFBQVEsRUFBRSxDQUFDQyxLQUFELEVBQVFDLElBQVIsRUFBY0MsSUFBZCxLQUF1QjtBQUM3QixRQUFJQyxLQUFLLENBQUNDLE9BQU4sQ0FBY0osS0FBZCxDQUFKLEVBQTBCLE9BQU9BLEtBQVA7O0FBRTFCLFFBQUksT0FBT0EsS0FBUCxLQUFpQixRQUFyQixFQUErQjtBQUMzQixVQUFJSyxPQUFPLEdBQUdMLEtBQUssQ0FBQ00sSUFBTixFQUFkOztBQUNBLFVBQUlELE9BQU8sQ0FBQ0UsVUFBUixDQUFtQixHQUFuQixLQUEyQkYsT0FBTyxDQUFDRyxRQUFSLENBQWlCLEdBQWpCLENBQS9CLEVBQXNEO0FBQ2xELGVBQU9DLElBQUksQ0FBQ0MsS0FBTCxDQUFXTCxPQUFYLENBQVA7QUFDSDs7QUFFRCxZQUFNLElBQUlYLG1CQUFKLENBQXlCLHlCQUF3Qk0sS0FBTSxFQUF2RCxDQUFOO0FBQ0g7O0FBRUQsV0FBTyxDQUFFQSxLQUFGLENBQVA7QUFDSCxHQWxCWTtBQW9CYlcsRUFBQUEsWUFBWSxFQUFFLEVBcEJEO0FBc0JiQyxFQUFBQSxRQUFRLEVBQUUsQ0FBQ1gsSUFBRCxFQUFPQyxJQUFQLEtBQWdCLElBdEJiO0FBd0JiVyxFQUFBQSxTQUFTLEVBQUdiLEtBQUQsSUFBV1IsU0FBUyxDQUFDUSxLQUFELENBQVQsR0FBbUIsSUFBbkIsR0FBMEJjLElBQUksQ0FBQ0MsU0FBTCxDQUFlZixLQUFmLENBeEJuQztBQTBCYmdCLEVBQUFBLFVBQVUsRUFBRXZCLEdBQUcsQ0FBQ3VCLFVBQUosQ0FBZUMsTUFBZixDQUFzQixDQUM5QixLQUQ4QixDQUF0QjtBQTFCQyxDQUFqQiIsInNvdXJjZXNDb250ZW50IjpbIlwidXNlIHN0cmljdFwiO1xuXG5jb25zdCBfID0gcmVxdWlyZSgncmstdXRpbHMnKS5fO1xuY29uc3QgeyBpc05vdGhpbmcgfSA9IHJlcXVpcmUoJy4uLy4uL3V0aWxzL2xhbmcnKTtcbmNvbnN0IGFueSA9IHJlcXVpcmUoJy4vYW55Jyk7XG5jb25zdCB7IERhdGFWYWxpZGF0aW9uRXJyb3IgfSA9IHJlcXVpcmUoJy4uLy4uL3J1bnRpbWUvRXJyb3JzJyk7XG5cbm1vZHVsZS5leHBvcnRzID0ge1xuICAgIG5hbWU6ICdhcnJheScsXG5cbiAgICBhbGlhczogWyAnbGlzdCcgXSxcblxuICAgIHNhbml0aXplOiAodmFsdWUsIGluZm8sIGkxOG4pID0+IHtcbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkodmFsdWUpKSByZXR1cm4gdmFsdWU7XG5cbiAgICAgICAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgIGxldCB0cmltbWVkID0gdmFsdWUudHJpbSgpO1xuICAgICAgICAgICAgaWYgKHRyaW1tZWQuc3RhcnRzV2l0aCgnWycpICYmIHRyaW1tZWQuZW5kc1dpdGgoJ10nKSkge1xuICAgICAgICAgICAgICAgIHJldHVybiBKU09OLnBhcnNlKHRyaW1tZWQpO1xuICAgICAgICAgICAgfSAgICAgICBcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgdGhyb3cgbmV3IERhdGFWYWxpZGF0aW9uRXJyb3IoYEludmFsaWQgYXJyYXkgZm9ybWF0OiAke3ZhbHVlfWApO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIFsgdmFsdWUgXTtcbiAgICB9LFxuXG4gICAgZGVmYXVsdFZhbHVlOiBbXSxcblxuICAgIGdlbmVyYXRlOiAoaW5mbywgaTE4bikgPT4gbnVsbCxcblxuICAgIHNlcmlhbGl6ZTogKHZhbHVlKSA9PiBpc05vdGhpbmcodmFsdWUpID8gbnVsbCA6IEpPU04uc3RyaW5naWZ5KHZhbHVlKSxcblxuICAgIHF1YWxpZmllcnM6IGFueS5xdWFsaWZpZXJzLmNvbmNhdChbXG4gICAgICAgICdjc3YnXG4gICAgXSlcbn07Il19