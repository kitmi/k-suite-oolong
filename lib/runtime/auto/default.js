"use strict";

require("source-map-support/register");

const Types = require('../types');

function auto(info, i18n) {
  if (!Types.Builtin.has(info.type)) {
    throw new Error(`Unknown primitive type: "${info.type}"."`);
  }

  if (!info.auto) {
    throw new Error(`Not an automatically generated field "${info.name}".`);
  }

  if (info.generator) {
    let name, options;

    if (typeof info.generator === 'string') {
      name = info.generator;
    } else if (Array.isArray(info.generator)) {
      if (!(info.generator.length > 0)) {
        throw new Error("Function \"auto\" assertion failed: info.generator.length > 0");
      }

      name = info.generator[0];

      if (info.generator.length > 1) {
        options = info.generator[1];
      }
    } else {
      name = info.generator.name;
      options = info.generator.options;
    }

    const G = require('../Generators');

    let gtor = G[name];
    return gtor(info, i18n, options);
  }

  let typeObjerct = Types[info.type];
  return typeObjerct.generate(info, i18n);
}

;
module.exports = auto;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9ydW50aW1lL2F1dG8vZGVmYXVsdC5qcyJdLCJuYW1lcyI6WyJUeXBlcyIsInJlcXVpcmUiLCJhdXRvIiwiaW5mbyIsImkxOG4iLCJCdWlsdGluIiwiaGFzIiwidHlwZSIsIm5hbWUiLCJnZW5lcmF0b3IiLCJvcHRpb25zIiwiQXJyYXkiLCJpc0FycmF5IiwibGVuZ3RoIiwiRyIsImd0b3IiLCJ0eXBlT2JqZXJjdCIsImdlbmVyYXRlIiwibW9kdWxlIiwiZXhwb3J0cyJdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7QUFFQSxNQUFNQSxLQUFLLEdBQUdDLE9BQU8sQ0FBQyxVQUFELENBQXJCOztBQUVBLFNBQVNDLElBQVQsQ0FBY0MsSUFBZCxFQUFvQkMsSUFBcEIsRUFBMEI7QUFBQSxPQUVsQkosS0FBSyxDQUFDSyxPQUFOLENBQWNDLEdBQWQsQ0FBa0JILElBQUksQ0FBQ0ksSUFBdkIsQ0FGa0I7QUFBQSxvQkFFYSw0QkFBMkJKLElBQUksQ0FBQ0ksSUFBSyxLQUZsRDtBQUFBOztBQUFBLE9BR2xCSixJQUFJLENBQUNELElBSGE7QUFBQSxvQkFHTix5Q0FBeUNDLElBQUksQ0FBQ0ssSUFBTSxJQUg5QztBQUFBOztBQU10QixNQUFJTCxJQUFJLENBQUNNLFNBQVQsRUFBb0I7QUFDaEIsUUFBSUQsSUFBSixFQUFVRSxPQUFWOztBQUdBLFFBQUksT0FBT1AsSUFBSSxDQUFDTSxTQUFaLEtBQTBCLFFBQTlCLEVBQXdDO0FBQ3BDRCxNQUFBQSxJQUFJLEdBQUdMLElBQUksQ0FBQ00sU0FBWjtBQUNILEtBRkQsTUFFTyxJQUFJRSxLQUFLLENBQUNDLE9BQU4sQ0FBY1QsSUFBSSxDQUFDTSxTQUFuQixDQUFKLEVBQW1DO0FBQUEsWUFDOUJOLElBQUksQ0FBQ00sU0FBTCxDQUFlSSxNQUFmLEdBQXdCLENBRE07QUFBQTtBQUFBOztBQUV0Q0wsTUFBQUEsSUFBSSxHQUFHTCxJQUFJLENBQUNNLFNBQUwsQ0FBZSxDQUFmLENBQVA7O0FBRUEsVUFBSU4sSUFBSSxDQUFDTSxTQUFMLENBQWVJLE1BQWYsR0FBd0IsQ0FBNUIsRUFBK0I7QUFDM0JILFFBQUFBLE9BQU8sR0FBR1AsSUFBSSxDQUFDTSxTQUFMLENBQWUsQ0FBZixDQUFWO0FBQ0g7QUFDSixLQVBNLE1BT0E7QUFDSEQsTUFBQUEsSUFBSSxHQUFHTCxJQUFJLENBQUNNLFNBQUwsQ0FBZUQsSUFBdEI7QUFDQUUsTUFBQUEsT0FBTyxHQUFHUCxJQUFJLENBQUNNLFNBQUwsQ0FBZUMsT0FBekI7QUFDSDs7QUFFRCxVQUFNSSxDQUFDLEdBQUdiLE9BQU8sQ0FBQyxlQUFELENBQWpCOztBQUNBLFFBQUljLElBQUksR0FBR0QsQ0FBQyxDQUFDTixJQUFELENBQVo7QUFDQSxXQUFPTyxJQUFJLENBQUNaLElBQUQsRUFBT0MsSUFBUCxFQUFhTSxPQUFiLENBQVg7QUFDSDs7QUFFRCxNQUFJTSxXQUFXLEdBQUdoQixLQUFLLENBQUNHLElBQUksQ0FBQ0ksSUFBTixDQUF2QjtBQUNBLFNBQU9TLFdBQVcsQ0FBQ0MsUUFBWixDQUFxQmQsSUFBckIsRUFBMkJDLElBQTNCLENBQVA7QUFDSDs7QUFBQTtBQUVEYyxNQUFNLENBQUNDLE9BQVAsR0FBaUJqQixJQUFqQiIsInNvdXJjZXNDb250ZW50IjpbIlwidXNlIHN0cmljdFwiO1xuXG5jb25zdCBUeXBlcyA9IHJlcXVpcmUoJy4uL3R5cGVzJyk7XG5cbmZ1bmN0aW9uIGF1dG8oaW5mbywgaTE4bikge1xuICAgIHByZToge1xuICAgICAgICBUeXBlcy5CdWlsdGluLmhhcyhpbmZvLnR5cGUpLCBgVW5rbm93biBwcmltaXRpdmUgdHlwZTogXCIke2luZm8udHlwZX1cIi5cImA7XG4gICAgICAgIGluZm8uYXV0bywgYE5vdCBhbiBhdXRvbWF0aWNhbGx5IGdlbmVyYXRlZCBmaWVsZCBcIiR7IGluZm8ubmFtZSB9XCIuYDtcbiAgICB9XG5cbiAgICBpZiAoaW5mby5nZW5lcmF0b3IpIHtcbiAgICAgICAgbGV0IG5hbWUsIG9wdGlvbnM7XG5cbiAgICAgICAgLy9jdXN0b21pemVkIGdlbmVyYXRvclxuICAgICAgICBpZiAodHlwZW9mIGluZm8uZ2VuZXJhdG9yID09PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgbmFtZSA9IGluZm8uZ2VuZXJhdG9yO1xuICAgICAgICB9IGVsc2UgaWYgKEFycmF5LmlzQXJyYXkoaW5mby5nZW5lcmF0b3IpKSB7XG4gICAgICAgICAgICBhc3NlcnQ6IGluZm8uZ2VuZXJhdG9yLmxlbmd0aCA+IDA7XG4gICAgICAgICAgICBuYW1lID0gaW5mby5nZW5lcmF0b3JbMF07XG5cbiAgICAgICAgICAgIGlmIChpbmZvLmdlbmVyYXRvci5sZW5ndGggPiAxKSB7XG4gICAgICAgICAgICAgICAgb3B0aW9ucyA9IGluZm8uZ2VuZXJhdG9yWzFdO1xuICAgICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgbmFtZSA9IGluZm8uZ2VuZXJhdG9yLm5hbWU7XG4gICAgICAgICAgICBvcHRpb25zID0gaW5mby5nZW5lcmF0b3Iub3B0aW9ucztcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IEcgPSByZXF1aXJlKCcuLi9HZW5lcmF0b3JzJyk7XG4gICAgICAgIGxldCBndG9yID0gR1tuYW1lXTtcbiAgICAgICAgcmV0dXJuIGd0b3IoaW5mbywgaTE4biwgb3B0aW9ucyk7XG4gICAgfSBcblxuICAgIGxldCB0eXBlT2JqZXJjdCA9IFR5cGVzW2luZm8udHlwZV07XG4gICAgcmV0dXJuIHR5cGVPYmplcmN0LmdlbmVyYXRlKGluZm8sIGkxOG4pO1xufTtcblxubW9kdWxlLmV4cG9ydHMgPSBhdXRvOyJdfQ==