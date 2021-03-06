"use strict";

require("source-map-support/register");

const Rules = require('../../enum/Rules');

const {
  mergeCondition
} = require('../../utils/lang');

const Generators = require('../Generators');

module.exports = {
  [Rules.RULE_BEFORE_FIND]: (feature, entityModel, context) => {
    let findOptions = context.options;

    if (!findOptions.$includeDeleted) {
      findOptions.$query = mergeCondition(findOptions.$query, {
        [feature.field]: {
          $ne: feature.value
        }
      });
    }

    return true;
  },
  [Rules.RULE_BEFORE_DELETE]: async (feature, entityModel, context) => {
    let options = context.options;

    if (!options.$physicalDeletion) {
      let {
        field,
        value,
        timestampField
      } = feature;
      let updateTo = {
        [field]: value
      };

      if (timestampField) {
        updateTo[timestampField] = Generators.default(entityModel.meta.fields[timestampField], context.i18n);
      }

      context.return = await entityModel._update_(updateTo, {
        $query: options.$query,
        $retrieveUpdated: options.$retrieveDeleted,
        $bypassReadOnly: new Set([field, timestampField])
      });
      return false;
    }

    return true;
  }
};
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9ydW50aW1lL2VudGl0eUZlYXR1cmVzL2xvZ2ljYWxEZWxldGlvbi5qcyJdLCJuYW1lcyI6WyJSdWxlcyIsInJlcXVpcmUiLCJtZXJnZUNvbmRpdGlvbiIsIkdlbmVyYXRvcnMiLCJtb2R1bGUiLCJleHBvcnRzIiwiUlVMRV9CRUZPUkVfRklORCIsImZlYXR1cmUiLCJlbnRpdHlNb2RlbCIsImNvbnRleHQiLCJmaW5kT3B0aW9ucyIsIm9wdGlvbnMiLCIkaW5jbHVkZURlbGV0ZWQiLCIkcXVlcnkiLCJmaWVsZCIsIiRuZSIsInZhbHVlIiwiUlVMRV9CRUZPUkVfREVMRVRFIiwiJHBoeXNpY2FsRGVsZXRpb24iLCJ0aW1lc3RhbXBGaWVsZCIsInVwZGF0ZVRvIiwiZGVmYXVsdCIsIm1ldGEiLCJmaWVsZHMiLCJpMThuIiwicmV0dXJuIiwiX3VwZGF0ZV8iLCIkcmV0cmlldmVVcGRhdGVkIiwiJHJldHJpZXZlRGVsZXRlZCIsIiRieXBhc3NSZWFkT25seSIsIlNldCJdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7QUFFQSxNQUFNQSxLQUFLLEdBQUdDLE9BQU8sQ0FBQyxrQkFBRCxDQUFyQjs7QUFDQSxNQUFNO0FBQUVDLEVBQUFBO0FBQUYsSUFBcUJELE9BQU8sQ0FBQyxrQkFBRCxDQUFsQzs7QUFDQSxNQUFNRSxVQUFVLEdBQUdGLE9BQU8sQ0FBQyxlQUFELENBQTFCOztBQU9BRyxNQUFNLENBQUNDLE9BQVAsR0FBaUI7QUFDYixHQUFDTCxLQUFLLENBQUNNLGdCQUFQLEdBQTBCLENBQUNDLE9BQUQsRUFBVUMsV0FBVixFQUF1QkMsT0FBdkIsS0FBbUM7QUFDekQsUUFBSUMsV0FBVyxHQUFHRCxPQUFPLENBQUNFLE9BQTFCOztBQUNBLFFBQUksQ0FBQ0QsV0FBVyxDQUFDRSxlQUFqQixFQUFrQztBQUM5QkYsTUFBQUEsV0FBVyxDQUFDRyxNQUFaLEdBQXFCWCxjQUFjLENBQUNRLFdBQVcsQ0FBQ0csTUFBYixFQUFxQjtBQUFFLFNBQUNOLE9BQU8sQ0FBQ08sS0FBVCxHQUFpQjtBQUFFQyxVQUFBQSxHQUFHLEVBQUVSLE9BQU8sQ0FBQ1M7QUFBZjtBQUFuQixPQUFyQixDQUFuQztBQUNIOztBQUVELFdBQU8sSUFBUDtBQUNILEdBUlk7QUFTYixHQUFDaEIsS0FBSyxDQUFDaUIsa0JBQVAsR0FBNEIsT0FBT1YsT0FBUCxFQUFnQkMsV0FBaEIsRUFBNkJDLE9BQTdCLEtBQXlDO0FBQ2pFLFFBQUlFLE9BQU8sR0FBR0YsT0FBTyxDQUFDRSxPQUF0Qjs7QUFDQSxRQUFJLENBQUNBLE9BQU8sQ0FBQ08saUJBQWIsRUFBZ0M7QUFDNUIsVUFBSTtBQUFFSixRQUFBQSxLQUFGO0FBQVNFLFFBQUFBLEtBQVQ7QUFBZ0JHLFFBQUFBO0FBQWhCLFVBQW1DWixPQUF2QztBQUNBLFVBQUlhLFFBQVEsR0FBRztBQUNYLFNBQUNOLEtBQUQsR0FBU0U7QUFERSxPQUFmOztBQUlBLFVBQUlHLGNBQUosRUFBb0I7QUFDaEJDLFFBQUFBLFFBQVEsQ0FBQ0QsY0FBRCxDQUFSLEdBQTJCaEIsVUFBVSxDQUFDa0IsT0FBWCxDQUFtQmIsV0FBVyxDQUFDYyxJQUFaLENBQWlCQyxNQUFqQixDQUF3QkosY0FBeEIsQ0FBbkIsRUFBNERWLE9BQU8sQ0FBQ2UsSUFBcEUsQ0FBM0I7QUFDSDs7QUFFRGYsTUFBQUEsT0FBTyxDQUFDZ0IsTUFBUixHQUFpQixNQUFNakIsV0FBVyxDQUFDa0IsUUFBWixDQUFxQk4sUUFBckIsRUFBK0I7QUFDbERQLFFBQUFBLE1BQU0sRUFBRUYsT0FBTyxDQUFDRSxNQURrQztBQUVsRGMsUUFBQUEsZ0JBQWdCLEVBQUVoQixPQUFPLENBQUNpQixnQkFGd0I7QUFHbERDLFFBQUFBLGVBQWUsRUFBRSxJQUFJQyxHQUFKLENBQVEsQ0FBQ2hCLEtBQUQsRUFBUUssY0FBUixDQUFSO0FBSGlDLE9BQS9CLENBQXZCO0FBTUEsYUFBTyxLQUFQO0FBQ0g7O0FBRUQsV0FBTyxJQUFQO0FBQ0g7QUEvQlksQ0FBakIiLCJzb3VyY2VzQ29udGVudCI6WyJcInVzZSBzdHJpY3RcIjtcblxuY29uc3QgUnVsZXMgPSByZXF1aXJlKCcuLi8uLi9lbnVtL1J1bGVzJyk7XG5jb25zdCB7IG1lcmdlQ29uZGl0aW9uIH0gPSByZXF1aXJlKCcuLi8uLi91dGlscy9sYW5nJyk7XG5jb25zdCBHZW5lcmF0b3JzID0gcmVxdWlyZSgnLi4vR2VuZXJhdG9ycycpO1xuXG4vKipcbiAqIEEgcnVsZSBzcGVjaWZpZXMgdGhlIGVudGl0eSB3aWxsIG5vdCBiZSBkZWxldGVkIHBoeXNpY2FsbHkuXG4gKiBAbW9kdWxlIEVudGl0eUZlYXR1cmVSdW50aW1lX0xvZ2ljYWxEZWxldGlvblxuICovXG5cbm1vZHVsZS5leHBvcnRzID0ge1xuICAgIFtSdWxlcy5SVUxFX0JFRk9SRV9GSU5EXTogKGZlYXR1cmUsIGVudGl0eU1vZGVsLCBjb250ZXh0KSA9PiB7XG4gICAgICAgIGxldCBmaW5kT3B0aW9ucyA9IGNvbnRleHQub3B0aW9ucztcbiAgICAgICAgaWYgKCFmaW5kT3B0aW9ucy4kaW5jbHVkZURlbGV0ZWQpIHtcbiAgICAgICAgICAgIGZpbmRPcHRpb25zLiRxdWVyeSA9IG1lcmdlQ29uZGl0aW9uKGZpbmRPcHRpb25zLiRxdWVyeSwgeyBbZmVhdHVyZS5maWVsZF06IHsgJG5lOiBmZWF0dXJlLnZhbHVlIH0gfSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9LFxuICAgIFtSdWxlcy5SVUxFX0JFRk9SRV9ERUxFVEVdOiBhc3luYyAoZmVhdHVyZSwgZW50aXR5TW9kZWwsIGNvbnRleHQpID0+IHtcbiAgICAgICAgbGV0IG9wdGlvbnMgPSBjb250ZXh0Lm9wdGlvbnM7XG4gICAgICAgIGlmICghb3B0aW9ucy4kcGh5c2ljYWxEZWxldGlvbikge1xuICAgICAgICAgICAgbGV0IHsgZmllbGQsIHZhbHVlLCB0aW1lc3RhbXBGaWVsZCB9ID0gZmVhdHVyZTtcbiAgICAgICAgICAgIGxldCB1cGRhdGVUbyA9IHtcbiAgICAgICAgICAgICAgICBbZmllbGRdOiB2YWx1ZVxuICAgICAgICAgICAgfTtcblxuICAgICAgICAgICAgaWYgKHRpbWVzdGFtcEZpZWxkKSB7XG4gICAgICAgICAgICAgICAgdXBkYXRlVG9bdGltZXN0YW1wRmllbGRdID0gR2VuZXJhdG9ycy5kZWZhdWx0KGVudGl0eU1vZGVsLm1ldGEuZmllbGRzW3RpbWVzdGFtcEZpZWxkXSwgY29udGV4dC5pMThuKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgY29udGV4dC5yZXR1cm4gPSBhd2FpdCBlbnRpdHlNb2RlbC5fdXBkYXRlXyh1cGRhdGVUbywgeyBcbiAgICAgICAgICAgICAgICAkcXVlcnk6IG9wdGlvbnMuJHF1ZXJ5LCBcbiAgICAgICAgICAgICAgICAkcmV0cmlldmVVcGRhdGVkOiBvcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQsXG4gICAgICAgICAgICAgICAgJGJ5cGFzc1JlYWRPbmx5OiBuZXcgU2V0KFtmaWVsZCwgdGltZXN0YW1wRmllbGRdKVxuICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbn07Il19