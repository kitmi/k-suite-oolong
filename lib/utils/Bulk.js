"use strict";

require("source-map-support/register");

const {
  waitUntil_
} = require('rk-utils');

class Bulk {
  constructor(limit, bulkAction, total) {
    this.limit = limit;
    this.itemsTotal = total;
    this.bulkAction = bulkAction;
    this.itemsPending = 0;
    this.itemsDone = 0;
    this.itemsError = 0;
    this._buffer = [];
  }

  flush() {
    if (this._buffer.length > 0) {
      let bulkItems = this._buffer.concat();

      this._buffer = [];
      let l = bulkItems.length;
      this.itemsPending += l;
      Promise.resolve(this.bulkAction(bulkItems)).then(() => {
        this.itemsDone += l;

        if (this.onProgress) {
          this.onProgress(this.itemsPending, this.itemsDone, this.itemsTotal);
        }
      }).catch(error => {
        this.itemsDone += l;
        this.itemsError += l;

        if (this.onError) {
          this.onError(error, this.itemsError);
        }
      });
    }
  }

  add(item) {
    this._buffer.push(item);

    if (this._buffer.length >= this.limit) {
      this.flush();
    }
  }

  async waitToEnd_(interval, maxRounds) {
    return waitUntil_(() => this.itemsDone >= this.itemsPending, interval, maxRounds);
  }

}

module.exports = Bulk;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy91dGlscy9CdWxrLmpzIl0sIm5hbWVzIjpbIndhaXRVbnRpbF8iLCJyZXF1aXJlIiwiQnVsayIsImNvbnN0cnVjdG9yIiwibGltaXQiLCJidWxrQWN0aW9uIiwidG90YWwiLCJpdGVtc1RvdGFsIiwiaXRlbXNQZW5kaW5nIiwiaXRlbXNEb25lIiwiaXRlbXNFcnJvciIsIl9idWZmZXIiLCJmbHVzaCIsImxlbmd0aCIsImJ1bGtJdGVtcyIsImNvbmNhdCIsImwiLCJQcm9taXNlIiwicmVzb2x2ZSIsInRoZW4iLCJvblByb2dyZXNzIiwiY2F0Y2giLCJlcnJvciIsIm9uRXJyb3IiLCJhZGQiLCJpdGVtIiwicHVzaCIsIndhaXRUb0VuZF8iLCJpbnRlcnZhbCIsIm1heFJvdW5kcyIsIm1vZHVsZSIsImV4cG9ydHMiXSwibWFwcGluZ3MiOiI7Ozs7QUFBQSxNQUFNO0FBQUVBLEVBQUFBO0FBQUYsSUFBaUJDLE9BQU8sQ0FBQyxVQUFELENBQTlCOztBQUVBLE1BQU1DLElBQU4sQ0FBVztBQUNQQyxFQUFBQSxXQUFXLENBQUNDLEtBQUQsRUFBUUMsVUFBUixFQUFvQkMsS0FBcEIsRUFBMkI7QUFDbEMsU0FBS0YsS0FBTCxHQUFhQSxLQUFiO0FBQ0EsU0FBS0csVUFBTCxHQUFrQkQsS0FBbEI7QUFDQSxTQUFLRCxVQUFMLEdBQWtCQSxVQUFsQjtBQUVBLFNBQUtHLFlBQUwsR0FBb0IsQ0FBcEI7QUFDQSxTQUFLQyxTQUFMLEdBQWlCLENBQWpCO0FBQ0EsU0FBS0MsVUFBTCxHQUFrQixDQUFsQjtBQUNBLFNBQUtDLE9BQUwsR0FBZSxFQUFmO0FBQ0g7O0FBRURDLEVBQUFBLEtBQUssR0FBRztBQUNKLFFBQUksS0FBS0QsT0FBTCxDQUFhRSxNQUFiLEdBQXNCLENBQTFCLEVBQTZCO0FBQ3pCLFVBQUlDLFNBQVMsR0FBRyxLQUFLSCxPQUFMLENBQWFJLE1BQWIsRUFBaEI7O0FBQ0EsV0FBS0osT0FBTCxHQUFlLEVBQWY7QUFFQSxVQUFJSyxDQUFDLEdBQUdGLFNBQVMsQ0FBQ0QsTUFBbEI7QUFDQSxXQUFLTCxZQUFMLElBQXFCUSxDQUFyQjtBQUVBQyxNQUFBQSxPQUFPLENBQUNDLE9BQVIsQ0FBZ0IsS0FBS2IsVUFBTCxDQUFnQlMsU0FBaEIsQ0FBaEIsRUFBNENLLElBQTVDLENBQWlELE1BQU07QUFDbkQsYUFBS1YsU0FBTCxJQUFrQk8sQ0FBbEI7O0FBRUEsWUFBSSxLQUFLSSxVQUFULEVBQXFCO0FBQ2pCLGVBQUtBLFVBQUwsQ0FBZ0IsS0FBS1osWUFBckIsRUFBbUMsS0FBS0MsU0FBeEMsRUFBbUQsS0FBS0YsVUFBeEQ7QUFDSDtBQUNKLE9BTkQsRUFNR2MsS0FOSCxDQU1TQyxLQUFLLElBQUk7QUFDZCxhQUFLYixTQUFMLElBQWtCTyxDQUFsQjtBQUNBLGFBQUtOLFVBQUwsSUFBbUJNLENBQW5COztBQUVBLFlBQUksS0FBS08sT0FBVCxFQUFrQjtBQUNkLGVBQUtBLE9BQUwsQ0FBYUQsS0FBYixFQUFvQixLQUFLWixVQUF6QjtBQUNIO0FBQ0osT0FiRDtBQWNIO0FBQ0o7O0FBRURjLEVBQUFBLEdBQUcsQ0FBQ0MsSUFBRCxFQUFPO0FBQ04sU0FBS2QsT0FBTCxDQUFhZSxJQUFiLENBQWtCRCxJQUFsQjs7QUFFQSxRQUFJLEtBQUtkLE9BQUwsQ0FBYUUsTUFBYixJQUF1QixLQUFLVCxLQUFoQyxFQUF1QztBQUNuQyxXQUFLUSxLQUFMO0FBQ0g7QUFDSjs7QUFFRCxRQUFNZSxVQUFOLENBQWlCQyxRQUFqQixFQUEyQkMsU0FBM0IsRUFBc0M7QUFDbEMsV0FBTzdCLFVBQVUsQ0FBQyxNQUFNLEtBQUtTLFNBQUwsSUFBa0IsS0FBS0QsWUFBOUIsRUFBNENvQixRQUE1QyxFQUFzREMsU0FBdEQsQ0FBakI7QUFDSDs7QUEvQ007O0FBa0RYQyxNQUFNLENBQUNDLE9BQVAsR0FBaUI3QixJQUFqQiIsInNvdXJjZXNDb250ZW50IjpbImNvbnN0IHsgd2FpdFVudGlsXyB9ID0gcmVxdWlyZSgncmstdXRpbHMnKTtcblxuY2xhc3MgQnVsayB7XG4gICAgY29uc3RydWN0b3IobGltaXQsIGJ1bGtBY3Rpb24sIHRvdGFsKSB7XG4gICAgICAgIHRoaXMubGltaXQgPSBsaW1pdDsgXG4gICAgICAgIHRoaXMuaXRlbXNUb3RhbCA9IHRvdGFsO1xuICAgICAgICB0aGlzLmJ1bGtBY3Rpb24gPSBidWxrQWN0aW9uO1xuXG4gICAgICAgIHRoaXMuaXRlbXNQZW5kaW5nID0gMDtcbiAgICAgICAgdGhpcy5pdGVtc0RvbmUgPSAwO1xuICAgICAgICB0aGlzLml0ZW1zRXJyb3IgPSAwO1xuICAgICAgICB0aGlzLl9idWZmZXIgPSBbXTsgICAgICAgICAgICAgIFxuICAgIH1cblxuICAgIGZsdXNoKCkgeyAgICAgICAgXG4gICAgICAgIGlmICh0aGlzLl9idWZmZXIubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgbGV0IGJ1bGtJdGVtcyA9IHRoaXMuX2J1ZmZlci5jb25jYXQoKTtcbiAgICAgICAgICAgIHRoaXMuX2J1ZmZlciA9IFtdO1xuXG4gICAgICAgICAgICBsZXQgbCA9IGJ1bGtJdGVtcy5sZW5ndGg7XG4gICAgICAgICAgICB0aGlzLml0ZW1zUGVuZGluZyArPSBsO1xuXG4gICAgICAgICAgICBQcm9taXNlLnJlc29sdmUodGhpcy5idWxrQWN0aW9uKGJ1bGtJdGVtcykpLnRoZW4oKCkgPT4ge1xuICAgICAgICAgICAgICAgIHRoaXMuaXRlbXNEb25lICs9IGw7XG5cbiAgICAgICAgICAgICAgICBpZiAodGhpcy5vblByb2dyZXNzKSB7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMub25Qcm9ncmVzcyh0aGlzLml0ZW1zUGVuZGluZywgdGhpcy5pdGVtc0RvbmUsIHRoaXMuaXRlbXNUb3RhbCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSkuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgICAgICAgICAgIHRoaXMuaXRlbXNEb25lICs9IGw7XG4gICAgICAgICAgICAgICAgdGhpcy5pdGVtc0Vycm9yICs9IGw7XG5cbiAgICAgICAgICAgICAgICBpZiAodGhpcy5vbkVycm9yKSB7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMub25FcnJvcihlcnJvciwgdGhpcy5pdGVtc0Vycm9yKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIGFkZChpdGVtKSB7XG4gICAgICAgIHRoaXMuX2J1ZmZlci5wdXNoKGl0ZW0pO1xuXG4gICAgICAgIGlmICh0aGlzLl9idWZmZXIubGVuZ3RoID49IHRoaXMubGltaXQpIHtcbiAgICAgICAgICAgIHRoaXMuZmx1c2goKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIGFzeW5jIHdhaXRUb0VuZF8oaW50ZXJ2YWwsIG1heFJvdW5kcykge1xuICAgICAgICByZXR1cm4gd2FpdFVudGlsXygoKSA9PiB0aGlzLml0ZW1zRG9uZSA+PSB0aGlzLml0ZW1zUGVuZGluZywgaW50ZXJ2YWwsIG1heFJvdW5kcyk7XG4gICAgfVxufVxuXG5tb2R1bGUuZXhwb3J0cyA9IEJ1bGs7Il19