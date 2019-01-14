"use strict";

require("source-map-support/register");

const {
  _
} = require('rk-utils');

const {
  generateDisplayName,
  deepCloneField,
  Clonable,
  fieldNaming
} = require('./OolUtils');

const Types = require('../runtime/types');

const RESERVED_KEYS = new Set(['name', 'type', 'modifiers', 'subClass', 'values']);

class Field extends Clonable {
  constructor(name, info) {
    super();
    this.name = fieldNaming(name);
    this.info = info;
  }

  link() {
    if (!Types.Builtin.has(this.info.type)) {
      throw new Error("Assertion failed: Types.Builtin.has(this.info.type)");
    }

    let typeObject = Types[this.info.type];

    _.forOwn(this.info, (value, key) => {
      if (RESERVED_KEYS.has(key)) {
        this[key] = value;
        return;
      }

      if (!typeObject.qualifiers.includes(key)) {
        this[key] = value;
        return;
      }

      this[key] = Array.isArray(value) ? value[0] : value;
    });

    this.displayName = this.comment || generateDisplayName(this.name);
    deepCloneField(this.info, this, 'modifiers');
    this.linked = true;
  }

  hasSameType(targetField) {
    return _.isEqual(this.toJSON(), targetField);
  }

  clone() {
    super.clone();
    let field = new Field(this.name, this.info);
    Object.assign(field, this.toJSON());
    field.linked = true;
    return field;
  }

  toJSON() {
    return _.omit(_.toPlainObject(this), ['name', 'linked', 'info']);
  }

}

module.exports = Field;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9sYW5nL0ZpZWxkLmpzIl0sIm5hbWVzIjpbIl8iLCJyZXF1aXJlIiwiZ2VuZXJhdGVEaXNwbGF5TmFtZSIsImRlZXBDbG9uZUZpZWxkIiwiQ2xvbmFibGUiLCJmaWVsZE5hbWluZyIsIlR5cGVzIiwiUkVTRVJWRURfS0VZUyIsIlNldCIsIkZpZWxkIiwiY29uc3RydWN0b3IiLCJuYW1lIiwiaW5mbyIsImxpbmsiLCJCdWlsdGluIiwiaGFzIiwidHlwZSIsInR5cGVPYmplY3QiLCJmb3JPd24iLCJ2YWx1ZSIsImtleSIsInF1YWxpZmllcnMiLCJpbmNsdWRlcyIsIkFycmF5IiwiaXNBcnJheSIsImRpc3BsYXlOYW1lIiwiY29tbWVudCIsImxpbmtlZCIsImhhc1NhbWVUeXBlIiwidGFyZ2V0RmllbGQiLCJpc0VxdWFsIiwidG9KU09OIiwiY2xvbmUiLCJmaWVsZCIsIk9iamVjdCIsImFzc2lnbiIsIm9taXQiLCJ0b1BsYWluT2JqZWN0IiwibW9kdWxlIiwiZXhwb3J0cyJdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7QUFFQSxNQUFNO0FBQUVBLEVBQUFBO0FBQUYsSUFBUUMsT0FBTyxDQUFDLFVBQUQsQ0FBckI7O0FBQ0EsTUFBTTtBQUFFQyxFQUFBQSxtQkFBRjtBQUF1QkMsRUFBQUEsY0FBdkI7QUFBdUNDLEVBQUFBLFFBQXZDO0FBQWlEQyxFQUFBQTtBQUFqRCxJQUFpRUosT0FBTyxDQUFDLFlBQUQsQ0FBOUU7O0FBQ0EsTUFBTUssS0FBSyxHQUFHTCxPQUFPLENBQUMsa0JBQUQsQ0FBckI7O0FBQ0EsTUFBTU0sYUFBYSxHQUFHLElBQUlDLEdBQUosQ0FBUSxDQUFDLE1BQUQsRUFBUyxNQUFULEVBQWlCLFdBQWpCLEVBQThCLFVBQTlCLEVBQTBDLFFBQTFDLENBQVIsQ0FBdEI7O0FBTUEsTUFBTUMsS0FBTixTQUFvQkwsUUFBcEIsQ0FBNkI7QUFLekJNLEVBQUFBLFdBQVcsQ0FBQ0MsSUFBRCxFQUFPQyxJQUFQLEVBQWE7QUFDcEI7QUFFQSxTQUFLRCxJQUFMLEdBQVlOLFdBQVcsQ0FBQ00sSUFBRCxDQUF2QjtBQU1BLFNBQUtDLElBQUwsR0FBWUEsSUFBWjtBQUNIOztBQUtEQyxFQUFBQSxJQUFJLEdBQUc7QUFBQSxTQUNLUCxLQUFLLENBQUNRLE9BQU4sQ0FBY0MsR0FBZCxDQUFrQixLQUFLSCxJQUFMLENBQVVJLElBQTVCLENBREw7QUFBQTtBQUFBOztBQUVILFFBQUlDLFVBQVUsR0FBR1gsS0FBSyxDQUFDLEtBQUtNLElBQUwsQ0FBVUksSUFBWCxDQUF0Qjs7QUFFQWhCLElBQUFBLENBQUMsQ0FBQ2tCLE1BQUYsQ0FBUyxLQUFLTixJQUFkLEVBQW9CLENBQUNPLEtBQUQsRUFBUUMsR0FBUixLQUFnQjtBQUNoQyxVQUFJYixhQUFhLENBQUNRLEdBQWQsQ0FBa0JLLEdBQWxCLENBQUosRUFBNEI7QUFDeEIsYUFBS0EsR0FBTCxJQUFZRCxLQUFaO0FBQ0E7QUFDSDs7QUFFRCxVQUFJLENBQUNGLFVBQVUsQ0FBQ0ksVUFBWCxDQUFzQkMsUUFBdEIsQ0FBK0JGLEdBQS9CLENBQUwsRUFBMEM7QUFDdEMsYUFBS0EsR0FBTCxJQUFZRCxLQUFaO0FBQ0E7QUFDSDs7QUFFRCxXQUFLQyxHQUFMLElBQVlHLEtBQUssQ0FBQ0MsT0FBTixDQUFjTCxLQUFkLElBQXVCQSxLQUFLLENBQUMsQ0FBRCxDQUE1QixHQUFrQ0EsS0FBOUM7QUFDSCxLQVpEOztBQWtCQSxTQUFLTSxXQUFMLEdBQW1CLEtBQUtDLE9BQUwsSUFBZ0J4QixtQkFBbUIsQ0FBQyxLQUFLUyxJQUFOLENBQXREO0FBRUFSLElBQUFBLGNBQWMsQ0FBQyxLQUFLUyxJQUFOLEVBQVksSUFBWixFQUFrQixXQUFsQixDQUFkO0FBRUEsU0FBS2UsTUFBTCxHQUFjLElBQWQ7QUFDSDs7QUFFREMsRUFBQUEsV0FBVyxDQUFDQyxXQUFELEVBQWM7QUFDckIsV0FBTzdCLENBQUMsQ0FBQzhCLE9BQUYsQ0FBVSxLQUFLQyxNQUFMLEVBQVYsRUFBeUJGLFdBQXpCLENBQVA7QUFDSDs7QUFNREcsRUFBQUEsS0FBSyxHQUFHO0FBQ0osVUFBTUEsS0FBTjtBQUVBLFFBQUlDLEtBQUssR0FBRyxJQUFJeEIsS0FBSixDQUFVLEtBQUtFLElBQWYsRUFBcUIsS0FBS0MsSUFBMUIsQ0FBWjtBQUNBc0IsSUFBQUEsTUFBTSxDQUFDQyxNQUFQLENBQWNGLEtBQWQsRUFBcUIsS0FBS0YsTUFBTCxFQUFyQjtBQUNBRSxJQUFBQSxLQUFLLENBQUNOLE1BQU4sR0FBZSxJQUFmO0FBRUEsV0FBT00sS0FBUDtBQUNIOztBQU1ERixFQUFBQSxNQUFNLEdBQUc7QUFDTCxXQUFPL0IsQ0FBQyxDQUFDb0MsSUFBRixDQUFPcEMsQ0FBQyxDQUFDcUMsYUFBRixDQUFnQixJQUFoQixDQUFQLEVBQThCLENBQUUsTUFBRixFQUFVLFFBQVYsRUFBb0IsTUFBcEIsQ0FBOUIsQ0FBUDtBQUNIOztBQXpFd0I7O0FBNEU3QkMsTUFBTSxDQUFDQyxPQUFQLEdBQWlCOUIsS0FBakIiLCJzb3VyY2VzQ29udGVudCI6WyJcInVzZSBzdHJpY3RcIjtcblxuY29uc3QgeyBfIH0gPSByZXF1aXJlKCdyay11dGlscycpO1xuY29uc3QgeyBnZW5lcmF0ZURpc3BsYXlOYW1lLCBkZWVwQ2xvbmVGaWVsZCwgQ2xvbmFibGUsIGZpZWxkTmFtaW5nIH0gPSByZXF1aXJlKCcuL09vbFV0aWxzJyk7XG5jb25zdCBUeXBlcyA9IHJlcXVpcmUoJy4uL3J1bnRpbWUvdHlwZXMnKTtcbmNvbnN0IFJFU0VSVkVEX0tFWVMgPSBuZXcgU2V0KFsnbmFtZScsICd0eXBlJywgJ21vZGlmaWVycycsICdzdWJDbGFzcycsICd2YWx1ZXMnXSk7XG5cbi8qKlxuICogT29sb25nIGVudGl0eSBmaWVsZCBjbGFzcy5cbiAqIEBjbGFzc1xuICovXG5jbGFzcyBGaWVsZCBleHRlbmRzIENsb25hYmxlIHtcbiAgICAvKipcbiAgICAgKiBAcGFyYW0ge3N0cmluZ30gbmFtZVxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBpbmZvXG4gICAgICovXG4gICAgY29uc3RydWN0b3IobmFtZSwgaW5mbykge1xuICAgICAgICBzdXBlcigpO1xuXG4gICAgICAgIHRoaXMubmFtZSA9IGZpZWxkTmFtaW5nKG5hbWUpO1xuXG4gICAgICAgIC8qKlxuICAgICAgICAgKiBPcmlnaW5hbCB0eXBlIGluZm9ybWF0aW9uLlxuICAgICAgICAgKiBAbWVtYmVyIHtvYmplY3R9XG4gICAgICAgICAqL1xuICAgICAgICB0aGlzLmluZm8gPSBpbmZvOyAgICAgICAgXG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogTGlua2luZyB0aGUgXG4gICAgICovXG4gICAgbGluaygpIHtcbiAgICAgICAgYXNzZXJ0OiBUeXBlcy5CdWlsdGluLmhhcyh0aGlzLmluZm8udHlwZSk7XG4gICAgICAgIGxldCB0eXBlT2JqZWN0ID0gVHlwZXNbdGhpcy5pbmZvLnR5cGVdO1xuXG4gICAgICAgIF8uZm9yT3duKHRoaXMuaW5mbywgKHZhbHVlLCBrZXkpID0+IHtcbiAgICAgICAgICAgIGlmIChSRVNFUlZFRF9LRVlTLmhhcyhrZXkpKSB7XG4gICAgICAgICAgICAgICAgdGhpc1trZXldID0gdmFsdWU7XG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfSAgICAgICBcblxuICAgICAgICAgICAgaWYgKCF0eXBlT2JqZWN0LnF1YWxpZmllcnMuaW5jbHVkZXMoa2V5KSkge1xuICAgICAgICAgICAgICAgIHRoaXNba2V5XSA9IHZhbHVlOyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHRoaXNba2V5XSA9IEFycmF5LmlzQXJyYXkodmFsdWUpID8gdmFsdWVbMF0gOiB2YWx1ZTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgLyoqXG4gICAgICAgICAqIFRoZSBkZWZhdWx0IG5hbWUgb2YgdGhlIGZpZWxkXG4gICAgICAgICAqIEBtZW1iZXIge3N0cmluZ31cbiAgICAgICAgICovXG4gICAgICAgIHRoaXMuZGlzcGxheU5hbWUgPSB0aGlzLmNvbW1lbnQgfHwgZ2VuZXJhdGVEaXNwbGF5TmFtZSh0aGlzLm5hbWUpOyAgICAgICAgXG5cbiAgICAgICAgZGVlcENsb25lRmllbGQodGhpcy5pbmZvLCB0aGlzLCAnbW9kaWZpZXJzJyk7XG5cbiAgICAgICAgdGhpcy5saW5rZWQgPSB0cnVlO1xuICAgIH1cblxuICAgIGhhc1NhbWVUeXBlKHRhcmdldEZpZWxkKSB7XG4gICAgICAgIHJldHVybiBfLmlzRXF1YWwodGhpcy50b0pTT04oKSwgdGFyZ2V0RmllbGQpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIENsb25lIHRoZSBmaWVsZCAgICAgXG4gICAgICogQHJldHVybnMge0ZpZWxkfVxuICAgICAqL1xuICAgIGNsb25lKCkge1xuICAgICAgICBzdXBlci5jbG9uZSgpO1xuXG4gICAgICAgIGxldCBmaWVsZCA9IG5ldyBGaWVsZCh0aGlzLm5hbWUsIHRoaXMuaW5mbyk7XG4gICAgICAgIE9iamVjdC5hc3NpZ24oZmllbGQsIHRoaXMudG9KU09OKCkpO1xuICAgICAgICBmaWVsZC5saW5rZWQgPSB0cnVlO1xuICAgICAgICBcbiAgICAgICAgcmV0dXJuIGZpZWxkO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFRyYW5zbGF0ZSB0aGUgZmllbGQgaW50byBhIHBsYWluIEpTT04gb2JqZWN0XG4gICAgICogQHJldHVybnMge29iamVjdH1cbiAgICAgKi9cbiAgICB0b0pTT04oKSB7XG4gICAgICAgIHJldHVybiBfLm9taXQoXy50b1BsYWluT2JqZWN0KHRoaXMpLCBbICduYW1lJywgJ2xpbmtlZCcsICdpbmZvJyBdKTtcbiAgICB9XG59XG5cbm1vZHVsZS5leHBvcnRzID0gRmllbGQ7Il19