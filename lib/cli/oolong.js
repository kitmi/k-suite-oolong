#!/usr/bin/env node
"use strict";

require("source-map-support/register");

if (process.env.DIAG_HANDLE) {
  const diagLog = require('why-is-node-running');

  setTimeout(function () {
    diagLog();
  }, 300000);
}

const CliApp = require('@k-suite/app');

const winston = require('winston');

const {
  combine,
  timestamp,
  colorize,
  json,
  simple
} = winston.format;

const OolongCore = require('./OolongCore');

const pkg = require('../../package.json');

let cliApp = new CliApp('oolong', {
  logger: {
    "transports": [{
      "type": "console",
      "options": {
        "level": "debug",
        "format": combine(colorize(), simple())
      }
    }]
  },
  loadConfigFromOptions: true,
  config: {
    "version": pkg.version,
    "commandLineOptions": {
      "banner": `Oolong command line helper v${pkg.version}`,
      "program": "oolong",
      "arguments": [{
        "name": "command",
        "default": 'main'
      }],
      "options": {
        "s": {
          "desc": "Silent mode",
          "alias": ["silent"],
          "isBool": true,
          "default": false
        },
        "v": {
          "desc": "Show version number",
          "alias": ["version"],
          "isBool": true,
          "default": false
        },
        "?": {
          "desc": "Show usage message",
          "alias": ["help"],
          "isBool": true,
          "default": false
        }
      }
    }
  }
});
cliApp.start_().then(async () => {
  let core = new OolongCore(cliApp);

  if (await core.initialize_()) {
    await core.execute_();
    return cliApp.stop_();
  }

  core.showUsage();
  await cliApp.stop_();
  process.exit(1);
}).catch(error => {
  console.error(error);
  process.exit(1);
});
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9jbGkvb29sb25nLmpzIl0sIm5hbWVzIjpbInByb2Nlc3MiLCJlbnYiLCJESUFHX0hBTkRMRSIsImRpYWdMb2ciLCJyZXF1aXJlIiwic2V0VGltZW91dCIsIkNsaUFwcCIsIndpbnN0b24iLCJjb21iaW5lIiwidGltZXN0YW1wIiwiY29sb3JpemUiLCJqc29uIiwic2ltcGxlIiwiZm9ybWF0IiwiT29sb25nQ29yZSIsInBrZyIsImNsaUFwcCIsImxvZ2dlciIsImxvYWRDb25maWdGcm9tT3B0aW9ucyIsImNvbmZpZyIsInZlcnNpb24iLCJzdGFydF8iLCJ0aGVuIiwiY29yZSIsImluaXRpYWxpemVfIiwiZXhlY3V0ZV8iLCJzdG9wXyIsInNob3dVc2FnZSIsImV4aXQiLCJjYXRjaCIsImVycm9yIiwiY29uc29sZSJdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7O0FBRUEsSUFBSUEsT0FBTyxDQUFDQyxHQUFSLENBQVlDLFdBQWhCLEVBQTZCO0FBQ3pCLFFBQU1DLE9BQU8sR0FBR0MsT0FBTyxDQUFDLHFCQUFELENBQXZCOztBQUNBQyxFQUFBQSxVQUFVLENBQUMsWUFBWTtBQUNuQkYsSUFBQUEsT0FBTztBQUNWLEdBRlMsRUFFUCxNQUZPLENBQVY7QUFHSDs7QUFFRCxNQUFNRyxNQUFNLEdBQUdGLE9BQU8sQ0FBQyxjQUFELENBQXRCOztBQUNBLE1BQU1HLE9BQU8sR0FBR0gsT0FBTyxDQUFDLFNBQUQsQ0FBdkI7O0FBQ0EsTUFBTTtBQUFFSSxFQUFBQSxPQUFGO0FBQVdDLEVBQUFBLFNBQVg7QUFBc0JDLEVBQUFBLFFBQXRCO0FBQWdDQyxFQUFBQSxJQUFoQztBQUFzQ0MsRUFBQUE7QUFBdEMsSUFBaURMLE9BQU8sQ0FBQ00sTUFBL0Q7O0FBQ0EsTUFBTUMsVUFBVSxHQUFHVixPQUFPLENBQUMsY0FBRCxDQUExQjs7QUFDQSxNQUFNVyxHQUFHLEdBQUdYLE9BQU8sQ0FBQyxvQkFBRCxDQUFuQjs7QUFFQSxJQUFJWSxNQUFNLEdBQUcsSUFBSVYsTUFBSixDQUFXLFFBQVgsRUFBcUI7QUFDOUJXLEVBQUFBLE1BQU0sRUFBRTtBQUNKLGtCQUFjLENBQ1Y7QUFDSSxjQUFRLFNBRFo7QUFFSSxpQkFBVztBQUNQLGlCQUFTLE9BREY7QUFFUCxrQkFBVVQsT0FBTyxDQUFDRSxRQUFRLEVBQVQsRUFBYUUsTUFBTSxFQUFuQjtBQUZWO0FBRmYsS0FEVTtBQURWLEdBRHNCO0FBWTlCTSxFQUFBQSxxQkFBcUIsRUFBRSxJQVpPO0FBYTlCQyxFQUFBQSxNQUFNLEVBQUU7QUFDSixlQUFXSixHQUFHLENBQUNLLE9BRFg7QUFFSiwwQkFBc0I7QUFDbEIsZ0JBQVcsK0JBQThCTCxHQUFHLENBQUNLLE9BQVEsRUFEbkM7QUFFbEIsaUJBQVcsUUFGTztBQUdsQixtQkFBYSxDQUNUO0FBQUUsZ0JBQVEsU0FBVjtBQUFxQixtQkFBVztBQUFoQyxPQURTLENBSEs7QUFNbEIsaUJBQVc7QUFDUCxhQUFLO0FBQ0Qsa0JBQVEsYUFEUDtBQUVELG1CQUFTLENBQUUsUUFBRixDQUZSO0FBR0Qsb0JBQVUsSUFIVDtBQUlELHFCQUFXO0FBSlYsU0FERTtBQU9QLGFBQUs7QUFDRCxrQkFBUSxxQkFEUDtBQUVELG1CQUFTLENBQUUsU0FBRixDQUZSO0FBR0Qsb0JBQVUsSUFIVDtBQUlELHFCQUFXO0FBSlYsU0FQRTtBQWFQLGFBQUs7QUFDRCxrQkFBUSxvQkFEUDtBQUVELG1CQUFTLENBQUUsTUFBRixDQUZSO0FBR0Qsb0JBQVUsSUFIVDtBQUlELHFCQUFXO0FBSlY7QUFiRTtBQU5PO0FBRmxCO0FBYnNCLENBQXJCLENBQWI7QUE2Q0FKLE1BQU0sQ0FBQ0ssTUFBUCxHQUFnQkMsSUFBaEIsQ0FBcUIsWUFBWTtBQUM3QixNQUFJQyxJQUFJLEdBQUcsSUFBSVQsVUFBSixDQUFlRSxNQUFmLENBQVg7O0FBRUEsTUFBSSxNQUFNTyxJQUFJLENBQUNDLFdBQUwsRUFBVixFQUE4QjtBQUMxQixVQUFNRCxJQUFJLENBQUNFLFFBQUwsRUFBTjtBQUNBLFdBQU9ULE1BQU0sQ0FBQ1UsS0FBUCxFQUFQO0FBQ0g7O0FBRURILEVBQUFBLElBQUksQ0FBQ0ksU0FBTDtBQUNBLFFBQU1YLE1BQU0sQ0FBQ1UsS0FBUCxFQUFOO0FBRUExQixFQUFBQSxPQUFPLENBQUM0QixJQUFSLENBQWEsQ0FBYjtBQUNILENBWkQsRUFZR0MsS0FaSCxDQVlTQyxLQUFLLElBQUk7QUFDZEMsRUFBQUEsT0FBTyxDQUFDRCxLQUFSLENBQWNBLEtBQWQ7QUFDQTlCLEVBQUFBLE9BQU8sQ0FBQzRCLElBQVIsQ0FBYSxDQUFiO0FBQ0gsQ0FmRCIsInNvdXJjZXNDb250ZW50IjpbIiMhL3Vzci9iaW4vZW52IG5vZGVcblxuaWYgKHByb2Nlc3MuZW52LkRJQUdfSEFORExFKSB7XG4gICAgY29uc3QgZGlhZ0xvZyA9IHJlcXVpcmUoJ3doeS1pcy1ub2RlLXJ1bm5pbmcnKTtcbiAgICBzZXRUaW1lb3V0KGZ1bmN0aW9uICgpIHtcbiAgICAgICAgZGlhZ0xvZygpIC8vIGxvZ3Mgb3V0IGFjdGl2ZSBoYW5kbGVzIHRoYXQgYXJlIGtlZXBpbmcgbm9kZSBydW5uaW5nXG4gICAgfSwgMzAwMDAwKTtcbn1cblxuY29uc3QgQ2xpQXBwID0gcmVxdWlyZSgnQGstc3VpdGUvYXBwJyk7XG5jb25zdCB3aW5zdG9uID0gcmVxdWlyZSgnd2luc3RvbicpO1xuY29uc3QgeyBjb21iaW5lLCB0aW1lc3RhbXAsIGNvbG9yaXplLCBqc29uLCBzaW1wbGUgfSA9IHdpbnN0b24uZm9ybWF0O1xuY29uc3QgT29sb25nQ29yZSA9IHJlcXVpcmUoJy4vT29sb25nQ29yZScpO1xuY29uc3QgcGtnID0gcmVxdWlyZSgnLi4vLi4vcGFja2FnZS5qc29uJyk7XG5cbmxldCBjbGlBcHAgPSBuZXcgQ2xpQXBwKCdvb2xvbmcnLCB7IFxuICAgIGxvZ2dlcjogeyAgICAgICAgXG4gICAgICAgIFwidHJhbnNwb3J0c1wiOiBbXG4gICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgXCJ0eXBlXCI6IFwiY29uc29sZVwiLFxuICAgICAgICAgICAgICAgIFwib3B0aW9uc1wiOiB7ICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBcImxldmVsXCI6IFwiZGVidWdcIixcbiAgICAgICAgICAgICAgICAgICAgXCJmb3JtYXRcIjogY29tYmluZShjb2xvcml6ZSgpLCBzaW1wbGUoKSlcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIF1cbiAgICB9LFxuICAgIGxvYWRDb25maWdGcm9tT3B0aW9uczogdHJ1ZSxcbiAgICBjb25maWc6IHtcbiAgICAgICAgXCJ2ZXJzaW9uXCI6IHBrZy52ZXJzaW9uLFxuICAgICAgICBcImNvbW1hbmRMaW5lT3B0aW9uc1wiOiB7XG4gICAgICAgICAgICBcImJhbm5lclwiOiBgT29sb25nIGNvbW1hbmQgbGluZSBoZWxwZXIgdiR7cGtnLnZlcnNpb259YCxcbiAgICAgICAgICAgIFwicHJvZ3JhbVwiOiBcIm9vbG9uZ1wiLFxuICAgICAgICAgICAgXCJhcmd1bWVudHNcIjogW1xuICAgICAgICAgICAgICAgIHsgXCJuYW1lXCI6IFwiY29tbWFuZFwiLCBcImRlZmF1bHRcIjogJ21haW4nIH1cbiAgICAgICAgICAgIF0sICBcbiAgICAgICAgICAgIFwib3B0aW9uc1wiOiB7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIFwic1wiOiB7XG4gICAgICAgICAgICAgICAgICAgIFwiZGVzY1wiOiBcIlNpbGVudCBtb2RlXCIsXG4gICAgICAgICAgICAgICAgICAgIFwiYWxpYXNcIjogWyBcInNpbGVudFwiIF0sXG4gICAgICAgICAgICAgICAgICAgIFwiaXNCb29sXCI6IHRydWUsXG4gICAgICAgICAgICAgICAgICAgIFwiZGVmYXVsdFwiOiBmYWxzZVxuICAgICAgICAgICAgICAgIH0sICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgXCJ2XCI6IHtcbiAgICAgICAgICAgICAgICAgICAgXCJkZXNjXCI6IFwiU2hvdyB2ZXJzaW9uIG51bWJlclwiLFxuICAgICAgICAgICAgICAgICAgICBcImFsaWFzXCI6IFsgXCJ2ZXJzaW9uXCIgXSxcbiAgICAgICAgICAgICAgICAgICAgXCJpc0Jvb2xcIjogdHJ1ZSxcbiAgICAgICAgICAgICAgICAgICAgXCJkZWZhdWx0XCI6IGZhbHNlXG4gICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICBcIj9cIjoge1xuICAgICAgICAgICAgICAgICAgICBcImRlc2NcIjogXCJTaG93IHVzYWdlIG1lc3NhZ2VcIixcbiAgICAgICAgICAgICAgICAgICAgXCJhbGlhc1wiOiBbIFwiaGVscFwiIF0sXG4gICAgICAgICAgICAgICAgICAgIFwiaXNCb29sXCI6IHRydWUsXG4gICAgICAgICAgICAgICAgICAgIFwiZGVmYXVsdFwiOiBmYWxzZVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH1cbn0pO1xuXG5jbGlBcHAuc3RhcnRfKCkudGhlbihhc3luYyAoKSA9PiB7XG4gICAgbGV0IGNvcmUgPSBuZXcgT29sb25nQ29yZShjbGlBcHApO1xuXG4gICAgaWYgKGF3YWl0IGNvcmUuaW5pdGlhbGl6ZV8oKSkge1xuICAgICAgICBhd2FpdCBjb3JlLmV4ZWN1dGVfKCk7ICAgICAgICBcbiAgICAgICAgcmV0dXJuIGNsaUFwcC5zdG9wXygpO1xuICAgIH0gICAgXG5cbiAgICBjb3JlLnNob3dVc2FnZSgpO1xuICAgIGF3YWl0IGNsaUFwcC5zdG9wXygpO1xuXG4gICAgcHJvY2Vzcy5leGl0KDEpO1xufSkuY2F0Y2goZXJyb3IgPT4ge1xuICAgIGNvbnNvbGUuZXJyb3IoZXJyb3IpO1xuICAgIHByb2Nlc3MuZXhpdCgxKTtcbn0pOyJdfQ==