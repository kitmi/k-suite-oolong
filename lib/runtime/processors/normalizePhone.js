"use strict";

require("source-map-support/register");

const {
  _,
  replaceAll
} = require('rk-utils');

function normalizePhone(phone, defaultArea) {
  if (phone) {
    phone = phone.trim();

    if (phone.length > 0) {
      let s = phone[0];

      if (s === '+') {} else if (s === '0') {
        if (phone[1] === '0') {
          phone = '+' + phone.substr(2);
        } else {
          phone = defaultArea + phone.substr(1);
        }
      } else {
        phone = defaultArea + phone;
      }

      let leftB = phone.indexOf('(');
      let rightB = phone.indexOf(')');

      if (leftB > 0 && rightB > leftB) {
        phone = phone.substr(0, leftB) + _.trimStart(phone.substring(leftB + 1, rightB), '0') + phone.substr(rightB + 1);
      }

      phone = phone.replace(/\ |\-/g, '');
    }
  }

  return phone;
}

module.exports = normalizePhone;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9ydW50aW1lL3Byb2Nlc3NvcnMvbm9ybWFsaXplUGhvbmUuanMiXSwibmFtZXMiOlsiXyIsInJlcGxhY2VBbGwiLCJyZXF1aXJlIiwibm9ybWFsaXplUGhvbmUiLCJwaG9uZSIsImRlZmF1bHRBcmVhIiwidHJpbSIsImxlbmd0aCIsInMiLCJzdWJzdHIiLCJsZWZ0QiIsImluZGV4T2YiLCJyaWdodEIiLCJ0cmltU3RhcnQiLCJzdWJzdHJpbmciLCJyZXBsYWNlIiwibW9kdWxlIiwiZXhwb3J0cyJdLCJtYXBwaW5ncyI6Ijs7OztBQUFBLE1BQU07QUFBRUEsRUFBQUEsQ0FBRjtBQUFLQyxFQUFBQTtBQUFMLElBQW9CQyxPQUFPLENBQUMsVUFBRCxDQUFqQzs7QUFFQSxTQUFTQyxjQUFULENBQXdCQyxLQUF4QixFQUErQkMsV0FBL0IsRUFBNEM7QUFDeEMsTUFBSUQsS0FBSixFQUFXO0FBQ1BBLElBQUFBLEtBQUssR0FBR0EsS0FBSyxDQUFDRSxJQUFOLEVBQVI7O0FBRUEsUUFBSUYsS0FBSyxDQUFDRyxNQUFOLEdBQWUsQ0FBbkIsRUFBc0I7QUFDbEIsVUFBSUMsQ0FBQyxHQUFHSixLQUFLLENBQUMsQ0FBRCxDQUFiOztBQUNBLFVBQUlJLENBQUMsS0FBSyxHQUFWLEVBQWUsQ0FFZCxDQUZELE1BRU8sSUFBSUEsQ0FBQyxLQUFLLEdBQVYsRUFBZTtBQUNsQixZQUFJSixLQUFLLENBQUMsQ0FBRCxDQUFMLEtBQWEsR0FBakIsRUFBc0I7QUFDbEJBLFVBQUFBLEtBQUssR0FBRyxNQUFNQSxLQUFLLENBQUNLLE1BQU4sQ0FBYSxDQUFiLENBQWQ7QUFDSCxTQUZELE1BRU87QUFDSEwsVUFBQUEsS0FBSyxHQUFHQyxXQUFXLEdBQUdELEtBQUssQ0FBQ0ssTUFBTixDQUFhLENBQWIsQ0FBdEI7QUFDSDtBQUNKLE9BTk0sTUFNQTtBQUNITCxRQUFBQSxLQUFLLEdBQUdDLFdBQVcsR0FBR0QsS0FBdEI7QUFDSDs7QUFFRCxVQUFJTSxLQUFLLEdBQUdOLEtBQUssQ0FBQ08sT0FBTixDQUFjLEdBQWQsQ0FBWjtBQUNBLFVBQUlDLE1BQU0sR0FBR1IsS0FBSyxDQUFDTyxPQUFOLENBQWMsR0FBZCxDQUFiOztBQUVBLFVBQUlELEtBQUssR0FBRyxDQUFSLElBQWFFLE1BQU0sR0FBR0YsS0FBMUIsRUFBaUM7QUFDN0JOLFFBQUFBLEtBQUssR0FBR0EsS0FBSyxDQUFDSyxNQUFOLENBQWEsQ0FBYixFQUFnQkMsS0FBaEIsSUFBeUJWLENBQUMsQ0FBQ2EsU0FBRixDQUFZVCxLQUFLLENBQUNVLFNBQU4sQ0FBZ0JKLEtBQUssR0FBQyxDQUF0QixFQUF5QkUsTUFBekIsQ0FBWixFQUE4QyxHQUE5QyxDQUF6QixHQUE4RVIsS0FBSyxDQUFDSyxNQUFOLENBQWFHLE1BQU0sR0FBQyxDQUFwQixDQUF0RjtBQUNIOztBQUVEUixNQUFBQSxLQUFLLEdBQUdBLEtBQUssQ0FBQ1csT0FBTixDQUFjLFFBQWQsRUFBd0IsRUFBeEIsQ0FBUjtBQUNIO0FBQ0o7O0FBRUQsU0FBT1gsS0FBUDtBQUNIOztBQUVEWSxNQUFNLENBQUNDLE9BQVAsR0FBaUJkLGNBQWpCIiwic291cmNlc0NvbnRlbnQiOlsiY29uc3QgeyBfLCByZXBsYWNlQWxsIH0gPSByZXF1aXJlKCdyay11dGlscycpO1xuXG5mdW5jdGlvbiBub3JtYWxpemVQaG9uZShwaG9uZSwgZGVmYXVsdEFyZWEpIHtcbiAgICBpZiAocGhvbmUpIHtcbiAgICAgICAgcGhvbmUgPSBwaG9uZS50cmltKCk7XG4gICAgICAgIFxuICAgICAgICBpZiAocGhvbmUubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgbGV0IHMgPSBwaG9uZVswXTtcbiAgICAgICAgICAgIGlmIChzID09PSAnKycpIHtcbiAgICAgICAgICAgICAgICAvL25vdGhpbmdcbiAgICAgICAgICAgIH0gZWxzZSBpZiAocyA9PT0gJzAnKSB7XG4gICAgICAgICAgICAgICAgaWYgKHBob25lWzFdID09PSAnMCcpIHtcbiAgICAgICAgICAgICAgICAgICAgcGhvbmUgPSAnKycgKyBwaG9uZS5zdWJzdHIoMik7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgcGhvbmUgPSBkZWZhdWx0QXJlYSArIHBob25lLnN1YnN0cigxKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHBob25lID0gZGVmYXVsdEFyZWEgKyBwaG9uZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IGxlZnRCID0gcGhvbmUuaW5kZXhPZignKCcpO1xuICAgICAgICAgICAgbGV0IHJpZ2h0QiA9IHBob25lLmluZGV4T2YoJyknKTtcblxuICAgICAgICAgICAgaWYgKGxlZnRCID4gMCAmJiByaWdodEIgPiBsZWZ0Qikge1xuICAgICAgICAgICAgICAgIHBob25lID0gcGhvbmUuc3Vic3RyKDAsIGxlZnRCKSArIF8udHJpbVN0YXJ0KHBob25lLnN1YnN0cmluZyhsZWZ0QisxLCByaWdodEIpLCAnMCcpICsgcGhvbmUuc3Vic3RyKHJpZ2h0QisxKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcGhvbmUgPSBwaG9uZS5yZXBsYWNlKC9cXCB8XFwtL2csICcnKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHJldHVybiBwaG9uZTtcbn1cblxubW9kdWxlLmV4cG9ydHMgPSBub3JtYWxpemVQaG9uZTsiXX0=