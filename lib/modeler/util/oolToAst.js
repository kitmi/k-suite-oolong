"use strict";

require("source-map-support/register");

const {
  _
} = require('rk-utils');

const {
  TopoSort
} = require('@k-suite/algorithms');

const JsLang = require('./ast.js');

const OolTypes = require('../../lang/OolTypes');

const {
  isDotSeparateName,
  extractDotSeparateName,
  extractReferenceBaseName
} = require('../../lang/OolUtils');

const OolongValidators = require('../../runtime/Validators');

const OolongProcessors = require('../../runtime/Processors');

const OolongActivators = require('../../runtime/Activators');

const Types = require('../../runtime/types');

const defaultError = 'InvalidRequest';
const AST_BLK_FIELD_PRE_PROCESS = 'FieldPreProcess';
const AST_BLK_PARAM_SANITIZE = 'ParameterSanitize';
const AST_BLK_PROCESSOR_CALL = 'ProcessorCall';
const AST_BLK_VALIDATOR_CALL = 'ValidatorCall';
const AST_BLK_ACTIVATOR_CALL = 'ActivatorCall';
const AST_BLK_VIEW_OPERATION = 'ViewOperation';
const AST_BLK_VIEW_RETURN = 'ViewReturn';
const AST_BLK_INTERFACE_OPERATION = 'InterfaceOperation';
const AST_BLK_INTERFACE_RETURN = 'InterfaceReturn';
const AST_BLK_EXCEPTION_ITEM = 'ExceptionItem';
const OOL_MODIFIER_CODE_FLAG = {
  [OolTypes.Modifier.VALIDATOR]: AST_BLK_VALIDATOR_CALL,
  [OolTypes.Modifier.PROCESSOR]: AST_BLK_PROCESSOR_CALL,
  [OolTypes.Modifier.ACTIVATOR]: AST_BLK_ACTIVATOR_CALL
};
const OOL_MODIFIER_OP = {
  [OolTypes.Modifier.VALIDATOR]: '~',
  [OolTypes.Modifier.PROCESSOR]: '|>',
  [OolTypes.Modifier.ACTIVATOR]: '='
};
const OOL_MODIFIER_PATH = {
  [OolTypes.Modifier.VALIDATOR]: 'validators',
  [OolTypes.Modifier.PROCESSOR]: 'processors',
  [OolTypes.Modifier.ACTIVATOR]: 'activators'
};
const OOL_MODIFIER_BUILTIN = {
  [OolTypes.Modifier.VALIDATOR]: OolongValidators,
  [OolTypes.Modifier.PROCESSOR]: OolongProcessors,
  [OolTypes.Modifier.ACTIVATOR]: OolongActivators
};
const OPERATOR_TOKEN = {
  ">": "$gt",
  "<": "$lt",
  ">=": "$gte",
  "<=": "$lte",
  "==": "$eq",
  "!=": "$ne",
  "in": "$in",
  "notIn": "$nin"
};

function compileConditionalExpression(test, compileContext, startTopoId) {
  if (_.isPlainObject(test)) {
    if (test.oolType === 'ValidateExpression') {
      let endTopoId = createTopoId(compileContext, startTopoId + '$valiOp:done');
      let operandTopoId = createTopoId(compileContext, startTopoId + '$valiOp');
      dependsOn(compileContext, startTopoId, operandTopoId);
      let lastOperandTopoId = compileConcreteValueExpression(operandTopoId, test.caller, compileContext);
      dependsOn(compileContext, lastOperandTopoId, endTopoId);
      let astArgument = getCodeRepresentationOf(lastOperandTopoId, compileContext);
      let retTopoId = compileAdHocValidator(endTopoId, astArgument, test.callee, compileContext);

      if (!(retTopoId === endTopoId)) {
        throw new Error("Function \"compileConditionalExpression\" assertion failed: retTopoId === endTopoId");
      }

      return endTopoId;
    } else if (test.oolType === 'LogicalExpression') {
      let endTopoId = createTopoId(compileContext, startTopoId + '$lopOp:done');
      let op;

      switch (test.operator) {
        case 'and':
          op = '&&';
          break;

        case 'or':
          op = '||';
          break;

        default:
          throw new Error('Unsupported test operator: ' + test.operator);
      }

      let leftTopoId = createTopoId(compileContext, startTopoId + '$lopOp:left');
      let rightTopoId = createTopoId(compileContext, startTopoId + '$lopOp:right');
      dependsOn(compileContext, startTopoId, leftTopoId);
      dependsOn(compileContext, startTopoId, rightTopoId);
      let lastLeftId = compileConditionalExpression(test.left, compileContext, leftTopoId);
      let lastRightId = compileConditionalExpression(test.right, compileContext, rightTopoId);
      dependsOn(compileContext, lastLeftId, endTopoId);
      dependsOn(compileContext, lastRightId, endTopoId);
      compileContext.astMap[endTopoId] = JsLang.astBinExp(getCodeRepresentationOf(lastLeftId, compileContext), op, getCodeRepresentationOf(lastRightId, compileContext));
      return endTopoId;
    } else if (test.oolType === 'BinaryExpression') {
      let endTopoId = createTopoId(compileContext, startTopoId + '$binOp:done');
      let op;

      switch (test.operator) {
        case '>':
        case '<':
        case '>=':
        case '<=':
        case 'in':
          op = test.operator;
          break;

        case '==':
          op = '===';
          break;

        case '!=':
          op = '!==';
          break;

        default:
          throw new Error('Unsupported test operator: ' + test.operator);
      }

      let leftTopoId = createTopoId(compileContext, startTopoId + '$binOp:left');
      let rightTopoId = createTopoId(compileContext, startTopoId + '$binOp:right');
      dependsOn(compileContext, startTopoId, leftTopoId);
      dependsOn(compileContext, startTopoId, rightTopoId);
      let lastLeftId = compileConcreteValueExpression(leftTopoId, test.left, compileContext);
      let lastRightId = compileConcreteValueExpression(rightTopoId, test.right, compileContext);
      dependsOn(compileContext, lastLeftId, endTopoId);
      dependsOn(compileContext, lastRightId, endTopoId);
      compileContext.astMap[endTopoId] = JsLang.astBinExp(getCodeRepresentationOf(lastLeftId, compileContext), op, getCodeRepresentationOf(lastRightId, compileContext));
      return endTopoId;
    } else if (test.oolType === 'UnaryExpression') {
      let endTopoId = createTopoId(compileContext, startTopoId + '$unaOp:done');
      let operandTopoId = createTopoId(compileContext, startTopoId + '$unaOp');
      dependsOn(compileContext, startTopoId, operandTopoId);
      let lastOperandTopoId = test.operator === 'not' ? compileConcreteValueExpression(operandTopoId, test.argument, compileContext) : compileConditionalExpression(test.argument, compileContext, operandTopoId);
      dependsOn(compileContext, lastOperandTopoId, endTopoId);
      let astArgument = getCodeRepresentationOf(lastOperandTopoId, compileContext);

      switch (test.operator) {
        case 'exists':
          compileContext.astMap[endTopoId] = JsLang.astNot(JsLang.astCall('_.isEmpty', astArgument));
          break;

        case 'is-not-null':
          compileContext.astMap[endTopoId] = JsLang.astNot(JsLang.astCall('_.isNil', astArgument));
          break;

        case 'not-exists':
          compileContext.astMap[endTopoId] = JsLang.astCall('_.isEmpty', astArgument);
          break;

        case 'is-null':
          compileContext.astMap[endTopoId] = JsLang.astCall('_.isNil', astArgument);
          break;

        case 'not':
          compileContext.astMap[endTopoId] = JsLang.astNot(astArgument);
          break;

        default:
          throw new Error('Unsupported test operator: ' + test.operator);
      }

      return endTopoId;
    } else {
      let valueStartTopoId = createTopoId(compileContext, startTopoId + '$value');
      dependsOn(compileContext, startTopoId, valueStartTopoId);
      return compileConcreteValueExpression(valueStartTopoId, test, compileContext);
    }
  }

  compileContext.astMap[startTopoId] = JsLang.astValue(test);
  return startTopoId;
}

function compileAdHocValidator(topoId, value, functor, compileContext) {
  if (!(functor.oolType === OolTypes.Modifier.VALIDATOR)) {
    throw new Error("Function \"compileAdHocValidator\" assertion failed: functor.oolType === OolTypes.Modifier.VALIDATOR");
  }

  let callArgs;

  if (functor.args) {
    callArgs = translateArgs(topoId, functor.args, compileContext);
  } else {
    callArgs = [];
  }

  let arg0 = value;
  compileContext.astMap[topoId] = JsLang.astCall('Validators.' + functor.name, [arg0].concat(callArgs));
  return topoId;
}

function compileModifier(topoId, value, functor, compileContext) {
  let declareParams;

  if (functor.oolType === OolTypes.Modifier.ACTIVATOR) {
    declareParams = translateFunctionParams(functor.args);
  } else {
    declareParams = translateFunctionParams(_.isEmpty(functor.args) ? [value] : [value].concat(functor.args));
  }

  let functorId = translateModifier(functor, compileContext, declareParams);
  let callArgs, references;

  if (functor.args) {
    callArgs = translateArgs(topoId, functor.args, compileContext);
    references = extractReferencedFields(functor.args);

    if (_.find(references, ref => ref === value.name)) {
      throw new Error('Cannot use the target field itself as an argument of a modifier.');
    }
  } else {
    callArgs = [];
  }

  if (functor.oolType === OolTypes.Modifier.ACTIVATOR) {
    compileContext.astMap[topoId] = JsLang.astAwait(functorId, [JsLang.astVarRef('this'), JsLang.astVarRef('context')].concat(callArgs));
  } else {
    let arg0 = value;

    if (!isTopLevelBlock(topoId) && _.isPlainObject(value) && value.oolType === 'ObjectReference' && value.name.startsWith('latest.')) {
      arg0 = JsLang.astConditional(JsLang.astCall('latest.hasOwnProperty', [extractReferenceBaseName(value.name)]), value, replaceVarRefScope(value, 'existing'));
    }

    compileContext.astMap[topoId] = JsLang.astCall(functorId, [arg0].concat(callArgs));
  }

  if (isTopLevelBlock(topoId)) {
    let targetVarName = value.name;
    let needDeclare = false;

    if (!isDotSeparateName(value.name) && compileContext.variables[value.name] && functor.oolType !== OolTypes.Modifier.VALIDATOR) {
      let counter = 1;

      do {
        counter++;
        targetVarName = value.name + counter.toString();
      } while (compileContext.variables.hasOwnProperty(targetVarName));

      compileContext.variables[targetVarName] = {
        type: 'localVariable',
        source: 'modifier'
      };
      needDeclare = true;
    }

    addCodeBlock(compileContext, topoId, {
      type: OOL_MODIFIER_CODE_FLAG[functor.oolType],
      target: targetVarName,
      references,
      needDeclare
    });
  }

  return topoId;
}

function extractReferencedFields(oolArgs) {
  oolArgs = _.castArray(oolArgs);
  let refs = [];
  oolArgs.forEach(a => {
    if (Array.isArray(a)) {
      refs = refs.concat(extractReferencedFields(a));
      return;
    }

    let result = checkReferenceToField(a);

    if (result) {
      refs.push(result);
    }
  });
  return refs;
}

function checkReferenceToField(obj) {
  if (_.isPlainObject(obj) && obj.oolType) {
    if (obj.oolType === 'PipedValue') return checkReferenceToField(obj.value);

    if (obj.oolType === 'ObjectReference') {
      return obj.name;
    }
  }

  return undefined;
}

function addModifierToMap(functorId, functorType, functorJsFile, mapOfFunctorToFile) {
  if (mapOfFunctorToFile[functorId] && mapOfFunctorToFile[functorId] !== functorJsFile) {
    throw new Error(`Conflict: ${functorType} naming "${functorId}" conflicts!`);
  }

  mapOfFunctorToFile[functorId] = functorJsFile;
}

function translateModifier(functor, compileContext, args) {
  let functionName, fileName, functorId;

  if (isDotSeparateName(functor.name)) {
    let names = extractDotSeparateName(functor.name);

    if (names.length > 2) {
      throw new Error('Not supported reference type: ' + functor.name);
    }

    let refEntityName = names[0];
    functionName = names[1];
    fileName = './' + OOL_MODIFIER_PATH[functor.oolType] + '/' + refEntityName + '-' + functionName + '.js';
    functorId = refEntityName + _.upperFirst(functionName);
    addModifierToMap(functorId, functor.oolType, fileName, compileContext.mapOfFunctorToFile);
  } else {
    functionName = functor.name;
    let builtins = OOL_MODIFIER_BUILTIN[functor.oolType];

    if (!(functionName in builtins)) {
      fileName = './' + OOL_MODIFIER_PATH[functor.oolType] + '/' + compileContext.moduleName + '-' + functionName + '.js';
      functorId = functionName;

      if (!compileContext.mapOfFunctorToFile[functorId]) {
        compileContext.newFunctorFiles.push({
          functionName,
          functorType: functor.oolType,
          fileName,
          args
        });
      }

      addModifierToMap(functorId, functor.oolType, fileName, compileContext.mapOfFunctorToFile);
    } else {
      functorId = functor.oolType + 's.' + functionName;
    }
  }

  return functorId;
}

function compilePipedValue(startTopoId, varOol, compileContext) {
  let lastTopoId = compileConcreteValueExpression(startTopoId, varOol.value, compileContext);
  varOol.modifiers.forEach(modifier => {
    let modifierStartTopoId = createTopoId(compileContext, startTopoId + OOL_MODIFIER_OP[modifier.oolType] + modifier.name);
    dependsOn(compileContext, lastTopoId, modifierStartTopoId);
    lastTopoId = compileModifier(modifierStartTopoId, varOol.value, modifier, compileContext);
  });
  return lastTopoId;
}

function compileVariableReference(startTopoId, varOol, compileContext) {
  if (!(_.isPlainObject(varOol) && varOol.oolType === 'ObjectReference')) {
    throw new Error("Function \"compileVariableReference\" precondition failed: _.isPlainObject(varOol) && varOol.oolType === 'ObjectReference'");
  }

  compileContext.astMap[startTopoId] = JsLang.astValue(varOol);
  return startTopoId;
}

function translateFunctionParams(args) {
  if (_.isEmpty(args)) return [];
  let names = new Set();

  function translateFunctionParam(arg, i) {
    if (_.isPlainObject(arg)) {
      if (arg.oolType === 'PipedValue') {
        return translateFunctionParam(arg.value);
      }

      if (arg.oolType === 'ObjectReference') {
        if (isDotSeparateName(arg.name)) {
          return extractDotSeparateName(arg.name).pop();
        }
      }

      return arg.name;
    }

    return 'param' + (i + 1).toString();
  }

  return _.map(args, (arg, i) => {
    let baseName = translateFunctionParam(arg, i);
    let name = baseName;
    let count = 2;

    while (names.has(name)) {
      name = baseName + count.toString();
      count++;
    }

    names.add(name);
    return name;
  });
}

function compileConcreteValueExpression(startTopoId, value, compileContext) {
  if (_.isPlainObject(value)) {
    if (value.oolType === 'PipedValue') {
      return compilePipedValue(startTopoId, value, compileContext);
    }

    if (value.oolType === 'ObjectReference') {
      let [refBase, ...rest] = extractDotSeparateName(value.name);
      let dependency;

      if (!compileContext.variables[refBase]) {
        throw new Error(`Referenced undefined variable: ${value.name}`);
      }

      if (compileContext.variables[refBase].type === 'entity' && !compileContext.variables[refBase].ongoing) {
        dependency = refBase;
      } else if (refBase === 'latest' && rest.length > 0) {
        let refFieldName = rest.pop();

        if (refFieldName !== startTopoId) {
          dependency = refFieldName + ':ready';
        }
      } else if (_.isEmpty(rest)) {
        dependency = refBase + ':ready';
      }

      if (dependency) {
        dependsOn(compileContext, dependency, startTopoId);
      }

      return compileVariableReference(startTopoId, value, compileContext);
    }

    if (value.oolType === 'RegExp') {
      compileContext.astMap[startTopoId] = JsLang.astValue(value);
      return startTopoId;
    }

    if (value.oorType === 'SymbolToken') {
      compileContext.astMap[startTopoId] = JsLang.astValue(translateSymbolToken(value.name));
      return startTopoId;
    }

    value = _.mapValues(value, (valueOfElement, key) => {
      let sid = createTopoId(compileContext, startTopoId + '.' + key);
      let eid = compileConcreteValueExpression(sid, valueOfElement, compileContext);

      if (sid !== eid) {
        dependsOn(compileContext, eid, startTopoId);
      }

      return compileContext.astMap[eid];
    });
  } else if (Array.isArray(value)) {
    value = _.map(value, (valueOfElement, index) => {
      let sid = createTopoId(compileContext, startTopoId + '[' + index + ']');
      let eid = compileConcreteValueExpression(sid, valueOfElement, compileContext);

      if (sid !== eid) {
        dependsOn(compileContext, eid, startTopoId);
      }

      return compileContext.astMap[eid];
    });
  }

  compileContext.astMap[startTopoId] = JsLang.astValue(value);
  return startTopoId;
}

function translateSymbolToken(name) {
  if (name === 'now') {
    return {
      "type": "CallExpression",
      "callee": {
        "type": "MemberExpression",
        "computed": false,
        "object": {
          "type": "MemberExpression",
          "computed": false,
          "object": {
            "type": "MemberExpression",
            "computed": false,
            "object": {
              "type": "Identifier",
              "name": "Types"
            },
            "property": {
              "type": "Identifier",
              "name": "DATETIME"
            }
          },
          "property": {
            "type": "Identifier",
            "name": "typeObject"
          }
        },
        "property": {
          "type": "Identifier",
          "name": "local"
        }
      },
      "arguments": []
    };
  }

  throw new Error('not support');
}

function translateArgs(topoId, args, compileContext) {
  args = _.castArray(args);
  if (_.isEmpty(args)) return [];
  let callArgs = [];

  _.each(args, (arg, i) => {
    let argTopoId = createTopoId(compileContext, topoId + ':arg[' + (i + 1).toString() + ']');
    let lastTopoId = compileConcreteValueExpression(argTopoId, arg, compileContext);
    dependsOn(compileContext, lastTopoId, topoId);
    callArgs = callArgs.concat(_.castArray(getCodeRepresentationOf(lastTopoId, compileContext)));
  });

  return callArgs;
}

function compileParam(index, param, compileContext) {
  let type = param.type;
  let typeObject = Types[type];

  if (!typeObject) {
    throw new Error('Unknown field type: ' + type);
  }

  let sanitizerName = `Types.${type.toUpperCase()}.sanitize`;
  let varRef = JsLang.astVarRef(param.name);
  let callAst = JsLang.astCall(sanitizerName, [varRef, JsLang.astArrayAccess('$meta.params', index), JsLang.astVarRef('this.db.i18n')]);
  let prepareTopoId = createTopoId(compileContext, '$params:sanitize[' + index.toString() + ']');
  compileContext.astMap[prepareTopoId] = [JsLang.astAssign(varRef, callAst, `Sanitize argument "${param.name}"`)];
  addCodeBlock(compileContext, prepareTopoId, {
    type: AST_BLK_PARAM_SANITIZE
  });
  dependsOn(compileContext, prepareTopoId, compileContext.mainStartId);
  let topoId = createTopoId(compileContext, param.name);
  dependsOn(compileContext, compileContext.mainStartId, topoId);
  let value = wrapParamReference(param.name, param);
  let endTopoId = compileVariableReference(topoId, value, compileContext);
  let readyTopoId = createTopoId(compileContext, topoId + ':ready');
  dependsOn(compileContext, endTopoId, readyTopoId);
  return readyTopoId;
}

function compileField(paramName, param, compileContext) {
  let topoId = createTopoId(compileContext, paramName);
  let contextName = 'latest.' + paramName;
  let value = wrapParamReference(contextName, param);
  let endTopoId = compileConcreteValueExpression(topoId, value, compileContext);
  let readyTopoId = createTopoId(compileContext, topoId + ':ready');
  dependsOn(compileContext, endTopoId, readyTopoId);
  return readyTopoId;
}

function wrapParamReference(name, value) {
  let ref = Object.assign({
    oolType: 'ObjectReference',
    name: name
  });

  if (!_.isEmpty(value.modifiers)) {
    return {
      oolType: 'PipedValue',
      value: ref,
      modifiers: value.modifiers
    };
  }

  return ref;
}

function hasModelField(operand, compileContext) {
  if (_.isPlainObject(operand) && operand.oolType === 'ObjectReference') {
    let [baseVar, ...rest] = operand.name.split('.');
    return compileContext.variables[baseVar] && compileContext.variables[baseVar].ongoing && rest.length > 0;
  }

  return false;
}

function translateReturnThenAst(startId, endId, then, compileContext) {
  if (_.isPlainObject(then)) {
    if (then.oolType === 'ThrowExpression') {
      let args;

      if (then.args) {
        args = translateArgs(startId, then.args, compileContext);
      } else {
        args = [];
      }

      return JsLang.astThrow(then.errorType || defaultError, then.message || args);
    }

    if (then.oolType === 'ReturnExpression') {
      return translateReturnValueAst(startId, endId, then.value, compileContext);
    }
  }

  if (_.isArray(then) || _.isPlainObject(then)) {
    let valueEndId = compileConcreteValueExpression(startId, then, compileContext);
    then = compileContext.astMap[valueEndId];
  }

  return JsLang.astReturn(then);
}

function translateThenAst(startId, endId, then, compileContext, assignTo) {
  if (_.isPlainObject(then)) {
    if (then.oolType === 'ThrowExpression') {
      let args;

      if (then.args) {
        args = translateArgs(startId, then.args, compileContext);
      } else {
        args = [];
      }

      return JsLang.astThrow(then.errorType || defaultError, then.message || args);
    }

    if (then.oolType === 'LogicalExpression') {}

    if (then.oolType === 'BinaryExpression') {
      if (!hasModelField(then.left, compileContext)) {
        throw new Error('Invalid query condition: the left operand need to be an entity field.');
      }

      if (hasModelField(then.right, compileContext)) {
        throw new Error('Invalid query condition: the right operand should not be an entity field. Use dataset instead if joining is required.');
      }

      let condition = {};
      let startRightId = createTopoId(compileContext, startId + '$binOp:right');
      dependsOn(compileContext, startId, startRightId);
      let lastRightId = compileConcreteValueExpression(startRightId, then.right, compileContext);
      dependsOn(compileContext, lastRightId, endId);

      if (then.operator === '==') {
        condition[then.left.name.split('.', 2)[1]] = compileContext.astMap[lastRightId];
      } else {
        condition[then.left.name.split('.', 2)[1]] = {
          [OPERATOR_TOKEN[op]]: compileContext.astMap[lastRightId]
        };
      }

      return JsLang.astAssign(assignTo, JsLang.astValue(condition));
    }

    if (then.oolType === 'UnaryExpression') {}
  }

  if (_.isArray(then) || _.isPlainObject(then)) {
    let valueEndId = compileConcreteValueExpression(startId, then, compileContext);
    then = compileContext.astMap[valueEndId];
  }

  return JsLang.astAssign(assignTo, then);
}

function translateReturnValueAst(startTopoId, endTopoId, value, compileContext) {
  let valueTopoId = compileConcreteValueExpression(startTopoId, value, compileContext);

  if (valueTopoId !== startTopoId) {
    dependsOn(compileContext, valueTopoId, endTopoId);
  }

  return JsLang.astReturn(getCodeRepresentationOf(valueTopoId, compileContext));
}

function compileReturn(startTopoId, value, compileContext) {
  let endTopoId = createTopoId(compileContext, '$return');
  dependsOn(compileContext, startTopoId, endTopoId);
  compileContext.astMap[endTopoId] = translateReturnValueAst(startTopoId, endTopoId, value, compileContext);
  addCodeBlock(compileContext, endTopoId, {
    type: AST_BLK_VIEW_RETURN
  });
  return endTopoId;
}

function compileFindOne(index, operation, compileContext, dependency) {
  if (!dependency) {
    throw new Error("Function \"compileFindOne\" precondition failed: dependency");
  }

  let endTopoId = createTopoId(compileContext, 'op$' + index.toString());
  let conditionVarName = endTopoId + '$condition';
  let ast = [JsLang.astVarDeclare(conditionVarName)];

  if (!operation.condition) {
    throw new Error("Function \"compileFindOne\" assertion failed: operation.condition");
  }

  compileContext.variables[operation.model] = {
    type: 'entity',
    source: 'findOne',
    ongoing: true
  };

  if (operation.condition.oolType) {
    if (operation.condition.oolType === 'cases') {
      let topoIdPrefix = endTopoId + '$cases';
      let lastStatement;

      if (operation.condition.else) {
        let elseStart = createTopoId(compileContext, topoIdPrefix + ':else');
        let elseEnd = createTopoId(compileContext, topoIdPrefix + ':end');
        dependsOn(compileContext, elseStart, elseEnd);
        dependsOn(compileContext, elseEnd, endTopoId);
        lastStatement = translateThenAst(elseStart, elseEnd, operation.condition.else, compileContext, conditionVarName);
      } else {
        lastStatement = JsLang.astThrow('ServerError', 'Unexpected state.');
      }

      if (_.isEmpty(operation.condition.items)) {
        throw new Error('Missing case items');
      }

      _.reverse(operation.condition.items).forEach((item, i) => {
        if (item.oolType !== 'ConditionalStatement') {
          throw new Error('Invalid case item.');
        }

        i = operation.condition.items.length - i - 1;
        let casePrefix = topoIdPrefix + '[' + i.toString() + ']';
        let caseTopoId = createTopoId(compileContext, casePrefix);
        dependsOn(compileContext, dependency, caseTopoId);
        let caseResultVarName = '$' + topoIdPrefix + '_' + i.toString();
        let lastTopoId = compileConditionalExpression(item.test, compileContext, caseTopoId);
        let astCaseTtem = getCodeRepresentationOf(lastTopoId, compileContext);

        if (!!Array.isArray(astCaseTtem)) {
          throw new Error('Invalid case item ast.');
        }

        astCaseTtem = JsLang.astVarDeclare(caseResultVarName, astCaseTtem, true, false, `Condition ${i} for find one ${operation.model}`);
        let ifStart = createTopoId(compileContext, casePrefix + ':then');
        let ifEnd = createTopoId(compileContext, casePrefix + ':end');
        dependsOn(compileContext, lastTopoId, ifStart);
        dependsOn(compileContext, ifStart, ifEnd);
        lastStatement = [astCaseTtem, JsLang.astIf(JsLang.astVarRef(caseResultVarName), JsLang.astBlock(translateThenAst(ifStart, ifEnd, item.then, compileContext, conditionVarName)), lastStatement)];
        dependsOn(compileContext, ifEnd, endTopoId);
      });

      ast = ast.concat(_.castArray(lastStatement));
    } else {
      throw new Error('todo');
    }
  } else {
    throw new Error('todo');
  }

  ast.push(JsLang.astVarDeclare(operation.model, JsLang.astAwait(`this.findOne_`, JsLang.astVarRef(conditionVarName))));
  delete compileContext.variables[operation.model].ongoing;
  let modelTopoId = createTopoId(compileContext, operation.model);
  dependsOn(compileContext, endTopoId, modelTopoId);
  compileContext.astMap[endTopoId] = ast;
  return endTopoId;
}

function compileDbOperation(index, operation, compileContext, dependency) {
  let lastTopoId;

  switch (operation.oolType) {
    case 'FindOneStatement':
      lastTopoId = compileFindOne(index, operation, compileContext, dependency);
      break;

    case 'find':
      throw new Error('tbi');
      break;

    case 'update':
      throw new Error('tbi');
      break;

    case 'create':
      throw new Error('tbi');
      break;

    case 'delete':
      throw new Error('tbi');
      break;

    case 'DoStatement':
      let doBlock = operation.do;
      lastTopoId = compileDoStatement(index, doBlock, compileContext, dependency);
      break;

    case 'assignment':
      throw new Error('tbi');
      break;

    default:
      throw new Error('Unsupported operation type: ' + operation.type);
  }

  addCodeBlock(compileContext, lastTopoId, {
    type: AST_BLK_INTERFACE_OPERATION
  });
  return lastTopoId;
}

function compileDoStatement(index, operation, compileContext, dependency) {}

function compileExceptionalReturn(oolNode, compileContext, dependency) {
  if (!(_.isPlainObject(oolNode) && oolNode.oolType === 'ReturnExpression')) {
    throw new Error("Function \"compileExceptionalReturn\" precondition failed: _.isPlainObject(oolNode) && oolNode.oolType === 'ReturnExpression'");
  }

  let endTopoId = createTopoId(compileContext, '$return'),
      lastExceptionId = dependency;

  if (!_.isEmpty(oolNode.exceptions)) {
    oolNode.exceptions.forEach((item, i) => {
      if (_.isPlainObject(item)) {
        if (item.oolType !== 'ConditionalStatement') {
          throw new Error('Unsupported exceptional type: ' + item.oolType);
        }

        let exceptionStartId = createTopoId(compileContext, endTopoId + ':except[' + i.toString() + ']');
        let exceptionEndId = createTopoId(compileContext, endTopoId + ':except[' + i.toString() + ']:done');

        if (lastExceptionId) {
          dependsOn(compileContext, lastExceptionId, exceptionStartId);
        }

        let lastTopoId = compileConditionalExpression(item.test, compileContext, exceptionStartId);
        let thenStartId = createTopoId(compileContext, exceptionStartId + ':then');
        dependsOn(compileContext, lastTopoId, thenStartId);
        dependsOn(compileContext, thenStartId, exceptionEndId);
        compileContext.astMap[exceptionEndId] = JsLang.astIf(getCodeRepresentationOf(lastTopoId, compileContext), JsLang.astBlock(translateReturnThenAst(thenStartId, exceptionEndId, item.then, compileContext)), null, `Return on exception #${i}`);
        addCodeBlock(compileContext, exceptionEndId, {
          type: AST_BLK_EXCEPTION_ITEM
        });
        lastExceptionId = exceptionEndId;
      } else {
        throw new Error('Unexpected.');
      }
    });
  }

  dependsOn(compileContext, lastExceptionId, endTopoId);
  let returnStartTopoId = createTopoId(compileContext, '$return:value');
  dependsOn(compileContext, returnStartTopoId, endTopoId);
  compileContext.astMap[endTopoId] = translateReturnValueAst(returnStartTopoId, endTopoId, oolNode.value, compileContext);
  addCodeBlock(compileContext, endTopoId, {
    type: AST_BLK_INTERFACE_RETURN
  });
  return endTopoId;
}

function createTopoId(compileContext, name) {
  if (compileContext.topoNodes.has(name)) {
    throw new Error(`Topo id "${name}" already created.`);
  }

  if (!!compileContext.topoSort.hasDependency(name)) {
    throw new Error('Already in topoSort!');
  }

  compileContext.topoNodes.add(name);
  return name;
}

function dependsOn(compileContext, previousOp, currentOp) {
  if (!(previousOp !== currentOp)) {
    throw new Error('Self depending');
  }

  compileContext.logger.debug(currentOp + ' \x1b[33mdepends on\x1b[0m ' + previousOp);

  if (!compileContext.topoNodes.has(currentOp)) {
    throw new Error(`Topo id "${currentOp}" not created.`);
  }

  compileContext.topoSort.add(previousOp, currentOp);
}

function addCodeBlock(compileContext, topoId, blockMeta) {
  if (!(topoId in compileContext.astMap)) {
    throw new Error(`AST not found for block with topoId: ${topoId}`);
  }

  compileContext.mapOfTokenToMeta.set(topoId, blockMeta);
  compileContext.logger.verbose(`Adding ${blockMeta.type} "${topoId}" into source code.`);
}

function getCodeRepresentationOf(topoId, compileContext) {
  let lastSourceType = compileContext.mapOfTokenToMeta.get(topoId);

  if (lastSourceType && (lastSourceType.type === AST_BLK_PROCESSOR_CALL || lastSourceType.type === AST_BLK_ACTIVATOR_CALL)) {
    return JsLang.astVarRef(lastSourceType.target, true);
  }

  let ast = compileContext.astMap[topoId];

  if (ast.type === 'MemberExpression' && ast.object.name === 'latest') {
    return JsLang.astConditional(JsLang.astCall('latest.hasOwnProperty', [ast.property.value]), ast, { ...ast,
      object: { ...ast.object,
        name: 'existing'
      }
    });
  }

  return compileContext.astMap[topoId];
}

function createCompileContext(moduleName, logger, sharedContext) {
  let compileContext = {
    moduleName,
    logger,
    variables: {},
    topoNodes: new Set(),
    topoSort: new TopoSort(),
    astMap: {},
    mapOfTokenToMeta: new Map(),
    modelVars: new Set(),
    mapOfFunctorToFile: sharedContext && sharedContext.mapOfFunctorToFile || {},
    newFunctorFiles: sharedContext && sharedContext.newFunctorFiles || []
  };
  compileContext.mainStartId = createTopoId(compileContext, '$main');
  logger.verbose(`Created compilation context for "${moduleName}".`);
  return compileContext;
}

function isTopLevelBlock(topoId) {
  return topoId.indexOf(':arg[') === -1 && topoId.indexOf('$cases[') === -1 && topoId.indexOf('$exceptions[') === -1;
}

function replaceVarRefScope(varRef, targetScope) {
  if (_.isPlainObject(varRef)) {
    if (!(varRef.oolType === 'ObjectReference')) {
      throw new Error("Function \"replaceVarRefScope\" assertion failed: varRef.oolType === 'ObjectReference'");
    }

    return {
      oolType: 'ObjectReference',
      name: replaceVarRefScope(varRef.name, targetScope)
    };
  }

  if (!(typeof varRef === 'string')) {
    throw new Error("Function \"replaceVarRefScope\" assertion failed: typeof varRef === 'string'");
  }

  let parts = varRef.split('.');

  if (!(parts.length > 1)) {
    throw new Error("Function \"replaceVarRefScope\" assertion failed: parts.length > 1");
  }

  parts.splice(0, 1, targetScope);
  return parts.join('.');
}

module.exports = {
  compileParam,
  compileField,
  compileDbOperation,
  compileExceptionalReturn,
  compileReturn,
  createTopoId,
  createCompileContext,
  dependsOn,
  addCodeBlock,
  AST_BLK_FIELD_PRE_PROCESS,
  AST_BLK_PROCESSOR_CALL,
  AST_BLK_VALIDATOR_CALL,
  AST_BLK_ACTIVATOR_CALL,
  AST_BLK_VIEW_OPERATION,
  AST_BLK_VIEW_RETURN,
  AST_BLK_INTERFACE_OPERATION,
  AST_BLK_INTERFACE_RETURN,
  AST_BLK_EXCEPTION_ITEM,
  OOL_MODIFIER_CODE_FLAG
};
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9tb2RlbGVyL3V0aWwvb29sVG9Bc3QuanMiXSwibmFtZXMiOlsiXyIsInJlcXVpcmUiLCJUb3BvU29ydCIsIkpzTGFuZyIsIk9vbFR5cGVzIiwiaXNEb3RTZXBhcmF0ZU5hbWUiLCJleHRyYWN0RG90U2VwYXJhdGVOYW1lIiwiZXh0cmFjdFJlZmVyZW5jZUJhc2VOYW1lIiwiT29sb25nVmFsaWRhdG9ycyIsIk9vbG9uZ1Byb2Nlc3NvcnMiLCJPb2xvbmdBY3RpdmF0b3JzIiwiVHlwZXMiLCJkZWZhdWx0RXJyb3IiLCJBU1RfQkxLX0ZJRUxEX1BSRV9QUk9DRVNTIiwiQVNUX0JMS19QQVJBTV9TQU5JVElaRSIsIkFTVF9CTEtfUFJPQ0VTU09SX0NBTEwiLCJBU1RfQkxLX1ZBTElEQVRPUl9DQUxMIiwiQVNUX0JMS19BQ1RJVkFUT1JfQ0FMTCIsIkFTVF9CTEtfVklFV19PUEVSQVRJT04iLCJBU1RfQkxLX1ZJRVdfUkVUVVJOIiwiQVNUX0JMS19JTlRFUkZBQ0VfT1BFUkFUSU9OIiwiQVNUX0JMS19JTlRFUkZBQ0VfUkVUVVJOIiwiQVNUX0JMS19FWENFUFRJT05fSVRFTSIsIk9PTF9NT0RJRklFUl9DT0RFX0ZMQUciLCJNb2RpZmllciIsIlZBTElEQVRPUiIsIlBST0NFU1NPUiIsIkFDVElWQVRPUiIsIk9PTF9NT0RJRklFUl9PUCIsIk9PTF9NT0RJRklFUl9QQVRIIiwiT09MX01PRElGSUVSX0JVSUxUSU4iLCJPUEVSQVRPUl9UT0tFTiIsImNvbXBpbGVDb25kaXRpb25hbEV4cHJlc3Npb24iLCJ0ZXN0IiwiY29tcGlsZUNvbnRleHQiLCJzdGFydFRvcG9JZCIsImlzUGxhaW5PYmplY3QiLCJvb2xUeXBlIiwiZW5kVG9wb0lkIiwiY3JlYXRlVG9wb0lkIiwib3BlcmFuZFRvcG9JZCIsImRlcGVuZHNPbiIsImxhc3RPcGVyYW5kVG9wb0lkIiwiY29tcGlsZUNvbmNyZXRlVmFsdWVFeHByZXNzaW9uIiwiY2FsbGVyIiwiYXN0QXJndW1lbnQiLCJnZXRDb2RlUmVwcmVzZW50YXRpb25PZiIsInJldFRvcG9JZCIsImNvbXBpbGVBZEhvY1ZhbGlkYXRvciIsImNhbGxlZSIsIm9wIiwib3BlcmF0b3IiLCJFcnJvciIsImxlZnRUb3BvSWQiLCJyaWdodFRvcG9JZCIsImxhc3RMZWZ0SWQiLCJsZWZ0IiwibGFzdFJpZ2h0SWQiLCJyaWdodCIsImFzdE1hcCIsImFzdEJpbkV4cCIsImFyZ3VtZW50IiwiYXN0Tm90IiwiYXN0Q2FsbCIsInZhbHVlU3RhcnRUb3BvSWQiLCJhc3RWYWx1ZSIsInRvcG9JZCIsInZhbHVlIiwiZnVuY3RvciIsImNhbGxBcmdzIiwiYXJncyIsInRyYW5zbGF0ZUFyZ3MiLCJhcmcwIiwibmFtZSIsImNvbmNhdCIsImNvbXBpbGVNb2RpZmllciIsImRlY2xhcmVQYXJhbXMiLCJ0cmFuc2xhdGVGdW5jdGlvblBhcmFtcyIsImlzRW1wdHkiLCJmdW5jdG9ySWQiLCJ0cmFuc2xhdGVNb2RpZmllciIsInJlZmVyZW5jZXMiLCJleHRyYWN0UmVmZXJlbmNlZEZpZWxkcyIsImZpbmQiLCJyZWYiLCJhc3RBd2FpdCIsImFzdFZhclJlZiIsImlzVG9wTGV2ZWxCbG9jayIsInN0YXJ0c1dpdGgiLCJhc3RDb25kaXRpb25hbCIsInJlcGxhY2VWYXJSZWZTY29wZSIsInRhcmdldFZhck5hbWUiLCJuZWVkRGVjbGFyZSIsInZhcmlhYmxlcyIsImNvdW50ZXIiLCJ0b1N0cmluZyIsImhhc093blByb3BlcnR5IiwidHlwZSIsInNvdXJjZSIsImFkZENvZGVCbG9jayIsInRhcmdldCIsIm9vbEFyZ3MiLCJjYXN0QXJyYXkiLCJyZWZzIiwiZm9yRWFjaCIsImEiLCJBcnJheSIsImlzQXJyYXkiLCJyZXN1bHQiLCJjaGVja1JlZmVyZW5jZVRvRmllbGQiLCJwdXNoIiwib2JqIiwidW5kZWZpbmVkIiwiYWRkTW9kaWZpZXJUb01hcCIsImZ1bmN0b3JUeXBlIiwiZnVuY3RvckpzRmlsZSIsIm1hcE9mRnVuY3RvclRvRmlsZSIsImZ1bmN0aW9uTmFtZSIsImZpbGVOYW1lIiwibmFtZXMiLCJsZW5ndGgiLCJyZWZFbnRpdHlOYW1lIiwidXBwZXJGaXJzdCIsImJ1aWx0aW5zIiwibW9kdWxlTmFtZSIsIm5ld0Z1bmN0b3JGaWxlcyIsImNvbXBpbGVQaXBlZFZhbHVlIiwidmFyT29sIiwibGFzdFRvcG9JZCIsIm1vZGlmaWVycyIsIm1vZGlmaWVyIiwibW9kaWZpZXJTdGFydFRvcG9JZCIsImNvbXBpbGVWYXJpYWJsZVJlZmVyZW5jZSIsIlNldCIsInRyYW5zbGF0ZUZ1bmN0aW9uUGFyYW0iLCJhcmciLCJpIiwicG9wIiwibWFwIiwiYmFzZU5hbWUiLCJjb3VudCIsImhhcyIsImFkZCIsInJlZkJhc2UiLCJyZXN0IiwiZGVwZW5kZW5jeSIsIm9uZ29pbmciLCJyZWZGaWVsZE5hbWUiLCJvb3JUeXBlIiwidHJhbnNsYXRlU3ltYm9sVG9rZW4iLCJtYXBWYWx1ZXMiLCJ2YWx1ZU9mRWxlbWVudCIsImtleSIsInNpZCIsImVpZCIsImluZGV4IiwiZWFjaCIsImFyZ1RvcG9JZCIsImNvbXBpbGVQYXJhbSIsInBhcmFtIiwidHlwZU9iamVjdCIsInNhbml0aXplck5hbWUiLCJ0b1VwcGVyQ2FzZSIsInZhclJlZiIsImNhbGxBc3QiLCJhc3RBcnJheUFjY2VzcyIsInByZXBhcmVUb3BvSWQiLCJhc3RBc3NpZ24iLCJtYWluU3RhcnRJZCIsIndyYXBQYXJhbVJlZmVyZW5jZSIsInJlYWR5VG9wb0lkIiwiY29tcGlsZUZpZWxkIiwicGFyYW1OYW1lIiwiY29udGV4dE5hbWUiLCJPYmplY3QiLCJhc3NpZ24iLCJoYXNNb2RlbEZpZWxkIiwib3BlcmFuZCIsImJhc2VWYXIiLCJzcGxpdCIsInRyYW5zbGF0ZVJldHVyblRoZW5Bc3QiLCJzdGFydElkIiwiZW5kSWQiLCJ0aGVuIiwiYXN0VGhyb3ciLCJlcnJvclR5cGUiLCJtZXNzYWdlIiwidHJhbnNsYXRlUmV0dXJuVmFsdWVBc3QiLCJ2YWx1ZUVuZElkIiwiYXN0UmV0dXJuIiwidHJhbnNsYXRlVGhlbkFzdCIsImFzc2lnblRvIiwiY29uZGl0aW9uIiwic3RhcnRSaWdodElkIiwidmFsdWVUb3BvSWQiLCJjb21waWxlUmV0dXJuIiwiY29tcGlsZUZpbmRPbmUiLCJvcGVyYXRpb24iLCJjb25kaXRpb25WYXJOYW1lIiwiYXN0IiwiYXN0VmFyRGVjbGFyZSIsIm1vZGVsIiwidG9wb0lkUHJlZml4IiwibGFzdFN0YXRlbWVudCIsImVsc2UiLCJlbHNlU3RhcnQiLCJlbHNlRW5kIiwiaXRlbXMiLCJyZXZlcnNlIiwiaXRlbSIsImNhc2VQcmVmaXgiLCJjYXNlVG9wb0lkIiwiY2FzZVJlc3VsdFZhck5hbWUiLCJhc3RDYXNlVHRlbSIsImlmU3RhcnQiLCJpZkVuZCIsImFzdElmIiwiYXN0QmxvY2siLCJtb2RlbFRvcG9JZCIsImNvbXBpbGVEYk9wZXJhdGlvbiIsImRvQmxvY2siLCJkbyIsImNvbXBpbGVEb1N0YXRlbWVudCIsImNvbXBpbGVFeGNlcHRpb25hbFJldHVybiIsIm9vbE5vZGUiLCJsYXN0RXhjZXB0aW9uSWQiLCJleGNlcHRpb25zIiwiZXhjZXB0aW9uU3RhcnRJZCIsImV4Y2VwdGlvbkVuZElkIiwidGhlblN0YXJ0SWQiLCJyZXR1cm5TdGFydFRvcG9JZCIsInRvcG9Ob2RlcyIsInRvcG9Tb3J0IiwiaGFzRGVwZW5kZW5jeSIsInByZXZpb3VzT3AiLCJjdXJyZW50T3AiLCJsb2dnZXIiLCJkZWJ1ZyIsImJsb2NrTWV0YSIsIm1hcE9mVG9rZW5Ub01ldGEiLCJzZXQiLCJ2ZXJib3NlIiwibGFzdFNvdXJjZVR5cGUiLCJnZXQiLCJvYmplY3QiLCJwcm9wZXJ0eSIsImNyZWF0ZUNvbXBpbGVDb250ZXh0Iiwic2hhcmVkQ29udGV4dCIsIk1hcCIsIm1vZGVsVmFycyIsImluZGV4T2YiLCJ0YXJnZXRTY29wZSIsInBhcnRzIiwic3BsaWNlIiwiam9pbiIsIm1vZHVsZSIsImV4cG9ydHMiXSwibWFwcGluZ3MiOiJBQUFBOzs7O0FBT0EsTUFBTTtBQUFFQSxFQUFBQTtBQUFGLElBQVFDLE9BQU8sQ0FBQyxVQUFELENB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RSxpQkFBWDtBQUE4Qm9DLE1BQUFBLElBQUksRUFBRWlCLGtCQUFrQixDQUFDeUUsTUFBTSxDQUFDMUYsSUFBUixFQUFja0wsV0FBZDtBQUF0RCxLQUFQO0FBQ0g7O0FBTDRDLFFBT3JDLE9BQU94RixNQUFQLEtBQWtCLFFBUG1CO0FBQUE7QUFBQTs7QUFTN0MsTUFBSXlGLEtBQUssR0FBR3pGLE1BQU0sQ0FBQ2dCLEtBQVAsQ0FBYSxHQUFiLENBQVo7O0FBVDZDLFFBVXJDeUUsS0FBSyxDQUFDcEksTUFBTixHQUFlLENBVnNCO0FBQUE7QUFBQTs7QUFZN0NvSSxFQUFBQSxLQUFLLENBQUNDLE1BQU4sQ0FBYSxDQUFiLEVBQWdCLENBQWhCLEVBQW1CRixXQUFuQjtBQUNBLFNBQU9DLEtBQUssQ0FBQ0UsSUFBTixDQUFXLEdBQVgsQ0FBUDtBQUNIOztBQUVEQyxNQUFNLENBQUNDLE9BQVAsR0FBaUI7QUFDYmxHLEVBQUFBLFlBRGE7QUFFYmEsRUFBQUEsWUFGYTtBQUdiZ0QsRUFBQUEsa0JBSGE7QUFJYkksRUFBQUEsd0JBSmE7QUFLYjVCLEVBQUFBLGFBTGE7QUFNYjVKLEVBQUFBLFlBTmE7QUFPYitNLEVBQUFBLG9CQVBhO0FBUWI3TSxFQUFBQSxTQVJhO0FBU2IwRCxFQUFBQSxZQVRhO0FBV2J0RixFQUFBQSx5QkFYYTtBQVliRSxFQUFBQSxzQkFaYTtBQWFiQyxFQUFBQSxzQkFiYTtBQWNiQyxFQUFBQSxzQkFkYTtBQWViQyxFQUFBQSxzQkFmYTtBQWdCYkMsRUFBQUEsbUJBaEJhO0FBaUJiQyxFQUFBQSwyQkFqQmE7QUFrQmJDLEVBQUFBLHdCQWxCYTtBQW1CYkMsRUFBQUEsc0JBbkJhO0FBcUJiQyxFQUFBQTtBQXJCYSxDQUFqQiIsInNvdXJjZXNDb250ZW50IjpbIlwidXNlIHN0cmljdFwiO1xuXG4vKipcbiAqIEBtb2R1bGVcbiAqIEBpZ25vcmVcbiAqL1xuXG5jb25zdCB7IF8gfSA9IHJlcXVpcmUoJ3JrLXV0aWxzJyk7XG5jb25zdCB7IFRvcG9Tb3J0IH0gPSByZXF1aXJlKCdAay1zdWl0ZS9hbGdvcml0aG1zJyk7XG5cbmNvbnN0IEpzTGFuZyA9IHJlcXVpcmUoJy4vYXN0LmpzJyk7XG5jb25zdCBPb2xUeXBlcyA9IHJlcXVpcmUoJy4uLy4uL2xhbmcvT29sVHlwZXMnKTtcbmNvbnN0IHsgaXNEb3RTZXBhcmF0ZU5hbWUsIGV4dHJhY3REb3RTZXBhcmF0ZU5hbWUsIGV4dHJhY3RSZWZlcmVuY2VCYXNlTmFtZSB9ID0gcmVxdWlyZSgnLi4vLi4vbGFuZy9Pb2xVdGlscycpO1xuY29uc3QgT29sb25nVmFsaWRhdG9ycyA9IHJlcXVpcmUoJy4uLy4uL3J1bnRpbWUvVmFsaWRhdG9ycycpO1xuY29uc3QgT29sb25nUHJvY2Vzc29ycyA9IHJlcXVpcmUoJy4uLy4uL3J1bnRpbWUvUHJvY2Vzc29ycycpO1xuY29uc3QgT29sb25nQWN0aXZhdG9ycyA9IHJlcXVpcmUoJy4uLy4uL3J1bnRpbWUvQWN0aXZhdG9ycycpO1xuY29uc3QgVHlwZXMgPSByZXF1aXJlKCcuLi8uLi9ydW50aW1lL3R5cGVzJyk7XG5cbmNvbnN0IGRlZmF1bHRFcnJvciA9ICdJbnZhbGlkUmVxdWVzdCc7XG5cbmNvbnN0IEFTVF9CTEtfRklFTERfUFJFX1BST0NFU1MgPSAnRmllbGRQcmVQcm9jZXNzJztcbmNvbnN0IEFTVF9CTEtfUEFSQU1fU0FOSVRJWkUgPSAnUGFyYW1ldGVyU2FuaXRpemUnO1xuY29uc3QgQVNUX0JMS19QUk9DRVNTT1JfQ0FMTCA9ICdQcm9jZXNzb3JDYWxsJztcbmNvbnN0IEFTVF9CTEtfVkFMSURBVE9SX0NBTEwgPSAnVmFsaWRhdG9yQ2FsbCc7XG5jb25zdCBBU1RfQkxLX0FDVElWQVRPUl9DQUxMID0gJ0FjdGl2YXRvckNhbGwnO1xuY29uc3QgQVNUX0JMS19WSUVXX09QRVJBVElPTiA9ICdWaWV3T3BlcmF0aW9uJztcbmNvbnN0IEFTVF9CTEtfVklFV19SRVRVUk4gPSAnVmlld1JldHVybic7XG5jb25zdCBBU1RfQkxLX0lOVEVSRkFDRV9PUEVSQVRJT04gPSAnSW50ZXJmYWNlT3BlcmF0aW9uJztcbmNvbnN0IEFTVF9CTEtfSU5URVJGQUNFX1JFVFVSTiA9ICdJbnRlcmZhY2VSZXR1cm4nO1xuY29uc3QgQVNUX0JMS19FWENFUFRJT05fSVRFTSA9ICdFeGNlcHRpb25JdGVtJztcblxuY29uc3QgT09MX01PRElGSUVSX0NPREVfRkxBRyA9IHtcbiAgICBbT29sVHlwZXMuTW9kaWZpZXIuVkFMSURBVE9SXTogQVNUX0JMS19WQUxJREFUT1JfQ0FMTCxcbiAgICBbT29sVHlwZXMuTW9kaWZpZXIuUFJPQ0VTU09SXTogQVNUX0JMS19QUk9DRVNTT1JfQ0FMTCxcbiAgICBbT29sVHlwZXMuTW9kaWZpZXIuQUNUSVZBVE9SXTogQVNUX0JMS19BQ1RJVkFUT1JfQ0FMTFxufTtcblxuY29uc3QgT09MX01PRElGSUVSX09QID0ge1xuICAgIFtPb2xUeXBlcy5Nb2RpZmllci5WQUxJREFUT1JdOiAnficsXG4gICAgW09vbFR5cGVzLk1vZGlmaWVyLlBST0NFU1NPUl06ICd8PicsXG4gICAgW09vbFR5cGVzLk1vZGlmaWVyLkFDVElWQVRPUl06ICc9JyBcbn07XG5cbmNvbnN0IE9PTF9NT0RJRklFUl9QQVRIID0ge1xuICAgIFtPb2xUeXBlcy5Nb2RpZmllci5WQUxJREFUT1JdOiAndmFsaWRhdG9ycycsXG4gICAgW09vbFR5cGVzLk1vZGlmaWVyLlBST0NFU1NPUl06ICdwcm9jZXNzb3JzJyxcbiAgICBbT29sVHlwZXMuTW9kaWZpZXIuQUNUSVZBVE9SXTogJ2FjdGl2YXRvcnMnIFxufTtcblxuY29uc3QgT09MX01PRElGSUVSX0JVSUxUSU4gPSB7XG4gICAgW09vbFR5cGVzLk1vZGlmaWVyLlZBTElEQVRPUl06IE9vbG9uZ1ZhbGlkYXRvcnMsXG4gICAgW09vbFR5cGVzLk1vZGlmaWVyLlBST0NFU1NPUl06IE9vbG9uZ1Byb2Nlc3NvcnMsXG4gICAgW09vbFR5cGVzLk1vZGlmaWVyLkFDVElWQVRPUl06IE9vbG9uZ0FjdGl2YXRvcnMgXG59O1xuXG5jb25zdCBPUEVSQVRPUl9UT0tFTiA9IHtcbiAgICBcIj5cIjogXCIkZ3RcIixcbiAgICBcIjxcIjogXCIkbHRcIixcbiAgICBcIj49XCI6IFwiJGd0ZVwiLFxuICAgIFwiPD1cIjogXCIkbHRlXCIsXG4gICAgXCI9PVwiOiBcIiRlcVwiLFxuICAgIFwiIT1cIjogXCIkbmVcIixcbiAgICBcImluXCI6IFwiJGluXCIsXG4gICAgXCJub3RJblwiOiBcIiRuaW5cIlxufTtcblxuLyoqXG4gKiBDb21waWxlIGEgY29uZGl0aW9uYWwgZXhwcmVzc2lvblxuICogQHBhcmFtIHtvYmplY3R9IHRlc3RcbiAqIEBwYXJhbSB7b2JqZWN0fSBjb21waWxlQ29udGV4dFxuICogQHByb3BlcnR5IHtzdHJpbmd9IGNvbXBpbGVDb250ZXh0Lm1vZHVsZU5hbWVcbiAqIEBwcm9wZXJ0eSB7VG9wb1NvcnR9IGNvbXBpbGVDb250ZXh0LnRvcG9Tb3J0XG4gKiBAcHJvcGVydHkge29iamVjdH0gY29tcGlsZUNvbnRleHQuYXN0TWFwIC0gVG9wbyBJZCB0byBhc3QgbWFwXG4gKiBAcGFyYW0ge3N0cmluZ30gc3RhcnRUb3BvSWRcbiAqIEByZXR1cm5zIHtzdHJpbmd9IFRvcG8gSWRcbiAqL1xuZnVuY3Rpb24gY29tcGlsZUNvbmRpdGlvbmFsRXhwcmVzc2lvbih0ZXN0LCBjb21waWxlQ29udGV4dCwgc3RhcnRUb3BvSWQpIHtcbiAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHRlc3QpKSB7ICAgICAgICBcbiAgICAgICAgaWYgKHRlc3Qub29sVHlwZSA9PT0gJ1ZhbGlkYXRlRXhwcmVzc2lvbicpIHtcbiAgICAgICAgICAgIGxldCBlbmRUb3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkICsgJyR2YWxpT3A6ZG9uZScpO1xuICAgICAgICAgICAgbGV0IG9wZXJhbmRUb3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkICsgJyR2YWxpT3AnKTtcblxuICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCwgb3BlcmFuZFRvcG9JZCk7XG5cbiAgICAgICAgICAgIGxldCBsYXN0T3BlcmFuZFRvcG9JZCA9IGNvbXBpbGVDb25jcmV0ZVZhbHVlRXhwcmVzc2lvbihvcGVyYW5kVG9wb0lkLCB0ZXN0LmNhbGxlciwgY29tcGlsZUNvbnRleHQpO1xuICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBsYXN0T3BlcmFuZFRvcG9JZCwgZW5kVG9wb0lkKTtcblxuICAgICAgICAgICAgbGV0IGFzdEFyZ3VtZW50ID0gZ2V0Q29kZVJlcHJlc2VudGF0aW9uT2YobGFzdE9wZXJhbmRUb3BvSWQsIGNvbXBpbGVDb250ZXh0KTtcblxuICAgICAgICAgICAgbGV0IHJldFRvcG9JZCA9IGNvbXBpbGVBZEhvY1ZhbGlkYXRvcihlbmRUb3BvSWQsIGFzdEFyZ3VtZW50LCB0ZXN0LmNhbGxlZSwgY29tcGlsZUNvbnRleHQpO1xuXG4gICAgICAgICAgICBhc3NlcnQ6IHJldFRvcG9JZCA9PT0gZW5kVG9wb0lkO1xuXG4gICAgICAgICAgICAvKlxuICAgICAgICAgICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW2VuZFRvcG9JZF0gPSBKc0xhbmcuYXN0Q2FsbCgnXy5pc0VtcHR5JywgYXN0QXJndW1lbnQpO1xuXG4gICAgICAgICAgICBzd2l0Y2ggKHRlc3Qub3BlcmF0b3IpIHtcbiAgICAgICAgICAgICAgICBjYXNlICdleGlzdHMnOlxuICAgICAgICAgICAgICAgICAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbZW5kVG9wb0lkXSA9IEpzTGFuZy5hc3ROb3QoSnNMYW5nLmFzdENhbGwoJ18uaXNFbXB0eScsIGFzdEFyZ3VtZW50KSk7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgY2FzZSAnaXMtbm90LW51bGwnOlxuICAgICAgICAgICAgICAgICAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbZW5kVG9wb0lkXSA9IEpzTGFuZy5hc3ROb3QoSnNMYW5nLmFzdENhbGwoJ18uaXNOaWwnLCBhc3RBcmd1bWVudCkpO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgICAgIGNhc2UgJ25vdC1leGlzdHMnOlxuICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgICAgICBjYXNlICdpcy1udWxsJzpcbiAgICAgICAgICAgICAgICAgICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW2VuZFRvcG9JZF0gPSBKc0xhbmcuYXN0Q2FsbCgnXy5pc05pbCcsIGFzdEFyZ3VtZW50KTtcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgICAgICBjYXNlICdub3QnOlxuICAgICAgICAgICAgICAgICAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbZW5kVG9wb0lkXSA9IEpzTGFuZy5hc3ROb3QoYXN0QXJndW1lbnQpO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5zdXBwb3J0ZWQgdGVzdCBvcGVyYXRvcjogJyArIHRlc3Qub3BlcmF0b3IpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgKi9cblxuICAgICAgICAgICAgcmV0dXJuIGVuZFRvcG9JZDtcblxuICAgICAgICB9IGVsc2UgaWYgKHRlc3Qub29sVHlwZSA9PT0gJ0xvZ2ljYWxFeHByZXNzaW9uJykge1xuICAgICAgICAgICAgbGV0IGVuZFRvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgc3RhcnRUb3BvSWQgKyAnJGxvcE9wOmRvbmUnKTtcblxuICAgICAgICAgICAgbGV0IG9wO1xuXG4gICAgICAgICAgICBzd2l0Y2ggKHRlc3Qub3BlcmF0b3IpIHtcbiAgICAgICAgICAgICAgICBjYXNlICdhbmQnOlxuICAgICAgICAgICAgICAgICAgICBvcCA9ICcmJic7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgY2FzZSAnb3InOlxuICAgICAgICAgICAgICAgICAgICBvcCA9ICd8fCc7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbnN1cHBvcnRlZCB0ZXN0IG9wZXJhdG9yOiAnICsgdGVzdC5vcGVyYXRvcik7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCBsZWZ0VG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCArICckbG9wT3A6bGVmdCcpO1xuICAgICAgICAgICAgbGV0IHJpZ2h0VG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCArICckbG9wT3A6cmlnaHQnKTtcblxuICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCwgbGVmdFRvcG9JZCk7XG4gICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkLCByaWdodFRvcG9JZCk7XG5cbiAgICAgICAgICAgIGxldCBsYXN0TGVmdElkID0gY29tcGlsZUNvbmRpdGlvbmFsRXhwcmVzc2lvbih0ZXN0LmxlZnQsIGNvbXBpbGVDb250ZXh0LCBsZWZ0VG9wb0lkKTtcbiAgICAgICAgICAgIGxldCBsYXN0UmlnaHRJZCA9IGNvbXBpbGVDb25kaXRpb25hbEV4cHJlc3Npb24odGVzdC5yaWdodCwgY29tcGlsZUNvbnRleHQsIHJpZ2h0VG9wb0lkKTtcblxuICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBsYXN0TGVmdElkLCBlbmRUb3BvSWQpO1xuICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBsYXN0UmlnaHRJZCwgZW5kVG9wb0lkKTtcblxuICAgICAgICAgICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW2VuZFRvcG9JZF0gPSBKc0xhbmcuYXN0QmluRXhwKFxuICAgICAgICAgICAgICAgIGdldENvZGVSZXByZXNlbnRhdGlvbk9mKGxhc3RMZWZ0SWQsIGNvbXBpbGVDb250ZXh0KSxcbiAgICAgICAgICAgICAgICBvcCxcbiAgICAgICAgICAgICAgICBnZXRDb2RlUmVwcmVzZW50YXRpb25PZihsYXN0UmlnaHRJZCwgY29tcGlsZUNvbnRleHQpXG4gICAgICAgICAgICApOyBcblxuICAgICAgICAgICAgcmV0dXJuIGVuZFRvcG9JZDtcblxuICAgICAgICB9IGVsc2UgaWYgKHRlc3Qub29sVHlwZSA9PT0gJ0JpbmFyeUV4cHJlc3Npb24nKSB7XG4gICAgICAgICAgICBsZXQgZW5kVG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCArICckYmluT3A6ZG9uZScpO1xuXG4gICAgICAgICAgICBsZXQgb3A7XG5cbiAgICAgICAgICAgIHN3aXRjaCAodGVzdC5vcGVyYXRvcikge1xuICAgICAgICAgICAgICAgIGNhc2UgJz4nOlxuICAgICAgICAgICAgICAgIGNhc2UgJzwnOlxuICAgICAgICAgICAgICAgIGNhc2UgJz49JzpcbiAgICAgICAgICAgICAgICBjYXNlICc8PSc6XG4gICAgICAgICAgICAgICAgY2FzZSAnaW4nOlxuICAgICAgICAgICAgICAgICAgICBvcCA9IHRlc3Qub3BlcmF0b3I7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgY2FzZSAnPT0nOlxuICAgICAgICAgICAgICAgICAgICBvcCA9ICc9PT0nO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgICAgIGNhc2UgJyE9JzpcbiAgICAgICAgICAgICAgICAgICAgb3AgPSAnIT09JztcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1Vuc3VwcG9ydGVkIHRlc3Qgb3BlcmF0b3I6ICcgKyB0ZXN0Lm9wZXJhdG9yKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IGxlZnRUb3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkICsgJyRiaW5PcDpsZWZ0Jyk7XG4gICAgICAgICAgICBsZXQgcmlnaHRUb3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkICsgJyRiaW5PcDpyaWdodCcpO1xuXG4gICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkLCBsZWZ0VG9wb0lkKTtcbiAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgc3RhcnRUb3BvSWQsIHJpZ2h0VG9wb0lkKTtcblxuICAgICAgICAgICAgbGV0IGxhc3RMZWZ0SWQgPSBjb21waWxlQ29uY3JldGVWYWx1ZUV4cHJlc3Npb24obGVmdFRvcG9JZCwgdGVzdC5sZWZ0LCBjb21waWxlQ29udGV4dCk7XG4gICAgICAgICAgICBsZXQgbGFzdFJpZ2h0SWQgPSBjb21waWxlQ29uY3JldGVWYWx1ZUV4cHJlc3Npb24ocmlnaHRUb3BvSWQsIHRlc3QucmlnaHQsIGNvbXBpbGVDb250ZXh0KTtcblxuICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBsYXN0TGVmdElkLCBlbmRUb3BvSWQpO1xuICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBsYXN0UmlnaHRJZCwgZW5kVG9wb0lkKTtcblxuICAgICAgICAgICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW2VuZFRvcG9JZF0gPSBKc0xhbmcuYXN0QmluRXhwKFxuICAgICAgICAgICAgICAgIGdldENvZGVSZXByZXNlbnRhdGlvbk9mKGxhc3RMZWZ0SWQsIGNvbXBpbGVDb250ZXh0KSxcbiAgICAgICAgICAgICAgICBvcCxcbiAgICAgICAgICAgICAgICBnZXRDb2RlUmVwcmVzZW50YXRpb25PZihsYXN0UmlnaHRJZCwgY29tcGlsZUNvbnRleHQpXG4gICAgICAgICAgICApOyBcblxuICAgICAgICAgICAgcmV0dXJuIGVuZFRvcG9JZDtcblxuICAgICAgICB9IGVsc2UgaWYgKHRlc3Qub29sVHlwZSA9PT0gJ1VuYXJ5RXhwcmVzc2lvbicpIHtcbiAgICAgICAgICAgIGxldCBlbmRUb3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkICsgJyR1bmFPcDpkb25lJyk7XG4gICAgICAgICAgICBsZXQgb3BlcmFuZFRvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgc3RhcnRUb3BvSWQgKyAnJHVuYU9wJyk7XG5cbiAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgc3RhcnRUb3BvSWQsIG9wZXJhbmRUb3BvSWQpO1xuXG4gICAgICAgICAgICBsZXQgbGFzdE9wZXJhbmRUb3BvSWQgPSB0ZXN0Lm9wZXJhdG9yID09PSAnbm90JyA/IGNvbXBpbGVDb25jcmV0ZVZhbHVlRXhwcmVzc2lvbihvcGVyYW5kVG9wb0lkLCB0ZXN0LmFyZ3VtZW50LCBjb21waWxlQ29udGV4dCkgOiBjb21waWxlQ29uZGl0aW9uYWxFeHByZXNzaW9uKHRlc3QuYXJndW1lbnQsIGNvbXBpbGVDb250ZXh0LCBvcGVyYW5kVG9wb0lkKTtcbiAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgbGFzdE9wZXJhbmRUb3BvSWQsIGVuZFRvcG9JZCk7XG5cbiAgICAgICAgICAgIGxldCBhc3RBcmd1bWVudCA9IGdldENvZGVSZXByZXNlbnRhdGlvbk9mKGxhc3RPcGVyYW5kVG9wb0lkLCBjb21waWxlQ29udGV4dCk7XG5cbiAgICAgICAgICAgIHN3aXRjaCAodGVzdC5vcGVyYXRvcikge1xuICAgICAgICAgICAgICAgIGNhc2UgJ2V4aXN0cyc6XG4gICAgICAgICAgICAgICAgICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtlbmRUb3BvSWRdID0gSnNMYW5nLmFzdE5vdChKc0xhbmcuYXN0Q2FsbCgnXy5pc0VtcHR5JywgYXN0QXJndW1lbnQpKTtcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgICAgICBjYXNlICdpcy1ub3QtbnVsbCc6XG4gICAgICAgICAgICAgICAgICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtlbmRUb3BvSWRdID0gSnNMYW5nLmFzdE5vdChKc0xhbmcuYXN0Q2FsbCgnXy5pc05pbCcsIGFzdEFyZ3VtZW50KSk7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgY2FzZSAnbm90LWV4aXN0cyc6XG4gICAgICAgICAgICAgICAgICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtlbmRUb3BvSWRdID0gSnNMYW5nLmFzdENhbGwoJ18uaXNFbXB0eScsIGFzdEFyZ3VtZW50KTtcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgICAgICBjYXNlICdpcy1udWxsJzpcbiAgICAgICAgICAgICAgICAgICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW2VuZFRvcG9JZF0gPSBKc0xhbmcuYXN0Q2FsbCgnXy5pc05pbCcsIGFzdEFyZ3VtZW50KTtcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgICAgICBjYXNlICdub3QnOlxuICAgICAgICAgICAgICAgICAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbZW5kVG9wb0lkXSA9IEpzTGFuZy5hc3ROb3QoYXN0QXJndW1lbnQpO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5zdXBwb3J0ZWQgdGVzdCBvcGVyYXRvcjogJyArIHRlc3Qub3BlcmF0b3IpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gZW5kVG9wb0lkO1xuXG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBsZXQgdmFsdWVTdGFydFRvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgc3RhcnRUb3BvSWQgKyAnJHZhbHVlJyk7XG4gICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkLCB2YWx1ZVN0YXJ0VG9wb0lkKTtcbiAgICAgICAgICAgIHJldHVybiBjb21waWxlQ29uY3JldGVWYWx1ZUV4cHJlc3Npb24odmFsdWVTdGFydFRvcG9JZCwgdGVzdCwgY29tcGlsZUNvbnRleHQpO1xuICAgICAgICB9IFxuICAgIH1cblxuICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtzdGFydFRvcG9JZF0gPSBKc0xhbmcuYXN0VmFsdWUodGVzdCk7XG4gICAgcmV0dXJuIHN0YXJ0VG9wb0lkO1xufVxuXG4vKipcbiAqIENvbXBpbGUgYSB2YWxpZGF0b3IgY2FsbGVkIGluIGEgbG9naWNhbCBleHByZXNzaW9uLlxuICogQHBhcmFtIHZhbHVlXG4gKiBAcGFyYW0gZnVuY3RvcnNcbiAqIEBwYXJhbSBjb21waWxlQ29udGV4dFxuICogQHBhcmFtIHRvcG9JbmZvXG4gKiBAcHJvcGVydHkge3N0cmluZ30gdG9wb0luZm8udG9wb0lkUHJlZml4XG4gKiBAcHJvcGVydHkge3N0cmluZ30gdG9wb0luZm8ubGFzdFRvcG9JZFxuICogQHJldHVybnMgeyp8c3RyaW5nfVxuICovXG5mdW5jdGlvbiBjb21waWxlQWRIb2NWYWxpZGF0b3IodG9wb0lkLCB2YWx1ZSwgZnVuY3RvciwgY29tcGlsZUNvbnRleHQpIHtcbiAgICBhc3NlcnQ6IGZ1bmN0b3Iub29sVHlwZSA9PT0gT29sVHlwZXMuTW9kaWZpZXIuVkFMSURBVE9SOyAgICAgICAgXG5cbiAgICBsZXQgY2FsbEFyZ3M7XG4gICAgXG4gICAgaWYgKGZ1bmN0b3IuYXJncykge1xuICAgICAgICBjYWxsQXJncyA9IHRyYW5zbGF0ZUFyZ3ModG9wb0lkLCBmdW5jdG9yLmFyZ3MsIGNvbXBpbGVDb250ZXh0KTsgICAgICAgIFxuICAgIH0gZWxzZSB7XG4gICAgICAgIGNhbGxBcmdzID0gW107XG4gICAgfSAgICAgICAgICAgIFxuICAgIFxuICAgIGxldCBhcmcwID0gdmFsdWU7XG4gICAgXG4gICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW3RvcG9JZF0gPSBKc0xhbmcuYXN0Q2FsbCgnVmFsaWRhdG9ycy4nICsgZnVuY3Rvci5uYW1lLCBbIGFyZzAgXS5jb25jYXQoY2FsbEFyZ3MpKTtcblxuICAgIHJldHVybiB0b3BvSWQ7XG59XG5cbi8qKlxuICogQ29tcGlsZSBhIG1vZGlmaWVyIGZyb20gb29sIHRvIGFzdC5cbiAqIEBwYXJhbSB0b3BvSWQgLSBzdGFydFRvcG9JZFxuICogQHBhcmFtIHZhbHVlXG4gKiBAcGFyYW0gZnVuY3RvcnNcbiAqIEBwYXJhbSBjb21waWxlQ29udGV4dFxuICogQHBhcmFtIHRvcG9JbmZvXG4gKiBAcHJvcGVydHkge3N0cmluZ30gdG9wb0luZm8udG9wb0lkUHJlZml4XG4gKiBAcHJvcGVydHkge3N0cmluZ30gdG9wb0luZm8ubGFzdFRvcG9JZFxuICogQHJldHVybnMgeyp8c3RyaW5nfVxuICovXG5mdW5jdGlvbiBjb21waWxlTW9kaWZpZXIodG9wb0lkLCB2YWx1ZSwgZnVuY3RvciwgY29tcGlsZUNvbnRleHQpIHtcbiAgICBsZXQgZGVjbGFyZVBhcmFtcztcblxuICAgIGlmIChmdW5jdG9yLm9vbFR5cGUgPT09IE9vbFR5cGVzLk1vZGlmaWVyLkFDVElWQVRPUikgeyBcbiAgICAgICAgZGVjbGFyZVBhcmFtcyA9IHRyYW5zbGF0ZUZ1bmN0aW9uUGFyYW1zKGZ1bmN0b3IuYXJncyk7ICAgICAgICBcbiAgICB9IGVsc2Uge1xuICAgICAgICBkZWNsYXJlUGFyYW1zID0gdHJhbnNsYXRlRnVuY3Rpb25QYXJhbXMoXy5pc0VtcHR5KGZ1bmN0b3IuYXJncykgPyBbdmFsdWVdIDogW3ZhbHVlXS5jb25jYXQoZnVuY3Rvci5hcmdzKSk7ICAgICAgICBcbiAgICB9ICAgICAgICBcblxuICAgIGxldCBmdW5jdG9ySWQgPSB0cmFuc2xhdGVNb2RpZmllcihmdW5jdG9yLCBjb21waWxlQ29udGV4dCwgZGVjbGFyZVBhcmFtcyk7XG5cbiAgICBsZXQgY2FsbEFyZ3MsIHJlZmVyZW5jZXM7XG4gICAgXG4gICAgaWYgKGZ1bmN0b3IuYXJncykge1xuICAgICAgICBjYWxsQXJncyA9IHRyYW5zbGF0ZUFyZ3ModG9wb0lkLCBmdW5jdG9yLmFyZ3MsIGNvbXBpbGVDb250ZXh0KTtcbiAgICAgICAgcmVmZXJlbmNlcyA9IGV4dHJhY3RSZWZlcmVuY2VkRmllbGRzKGZ1bmN0b3IuYXJncyk7XG5cbiAgICAgICAgaWYgKF8uZmluZChyZWZlcmVuY2VzLCByZWYgPT4gcmVmID09PSB2YWx1ZS5uYW1lKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdDYW5ub3QgdXNlIHRoZSB0YXJnZXQgZmllbGQgaXRzZWxmIGFzIGFuIGFyZ3VtZW50IG9mIGEgbW9kaWZpZXIuJyk7XG4gICAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgICBjYWxsQXJncyA9IFtdO1xuICAgIH0gICAgICAgIFxuICAgIFxuICAgIGlmIChmdW5jdG9yLm9vbFR5cGUgPT09IE9vbFR5cGVzLk1vZGlmaWVyLkFDVElWQVRPUikgeyAgICAgICAgICAgIFxuICAgICAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbdG9wb0lkXSA9IEpzTGFuZy5hc3RBd2FpdChmdW5jdG9ySWQsIFsgSnNMYW5nLmFzdFZhclJlZigndGhpcycpLCBKc0xhbmcuYXN0VmFyUmVmKCdjb250ZXh0JykgXS5jb25jYXQoY2FsbEFyZ3MpKTtcbiAgICB9IGVsc2Uge1xuICAgICAgICBsZXQgYXJnMCA9IHZhbHVlO1xuICAgICAgICBpZiAoIWlzVG9wTGV2ZWxCbG9jayh0b3BvSWQpICYmIF8uaXNQbGFpbk9iamVjdCh2YWx1ZSkgJiYgdmFsdWUub29sVHlwZSA9PT0gJ09iamVjdFJlZmVyZW5jZScgJiYgdmFsdWUubmFtZS5zdGFydHNXaXRoKCdsYXRlc3QuJykpIHtcbiAgICAgICAgICAgIC8vbGV0IGV4aXN0aW5nUmVmID0gICAgICAgICAgICBcbiAgICAgICAgICAgIGFyZzAgPSBKc0xhbmcuYXN0Q29uZGl0aW9uYWwoXG4gICAgICAgICAgICAgICAgSnNMYW5nLmFzdENhbGwoJ2xhdGVzdC5oYXNPd25Qcm9wZXJ0eScsIFsgZXh0cmFjdFJlZmVyZW5jZUJhc2VOYW1lKHZhbHVlLm5hbWUpIF0pLCAvKiogdGVzdCAqL1xuICAgICAgICAgICAgICAgIHZhbHVlLCAvKiogY29uc2VxdWVudCAqL1xuICAgICAgICAgICAgICAgIHJlcGxhY2VWYXJSZWZTY29wZSh2YWx1ZSwgJ2V4aXN0aW5nJylcbiAgICAgICAgICAgICk7ICBcbiAgICAgICAgfVxuICAgICAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbdG9wb0lkXSA9IEpzTGFuZy5hc3RDYWxsKGZ1bmN0b3JJZCwgWyBhcmcwIF0uY29uY2F0KGNhbGxBcmdzKSk7XG4gICAgfSAgICBcblxuICAgIGlmIChpc1RvcExldmVsQmxvY2sodG9wb0lkKSkge1xuICAgICAgICBsZXQgdGFyZ2V0VmFyTmFtZSA9IHZhbHVlLm5hbWU7XG4gICAgICAgIGxldCBuZWVkRGVjbGFyZSA9IGZhbHNlO1xuXG4gICAgICAgIGlmICghaXNEb3RTZXBhcmF0ZU5hbWUodmFsdWUubmFtZSkgJiYgY29tcGlsZUNvbnRleHQudmFyaWFibGVzW3ZhbHVlLm5hbWVdICYmIGZ1bmN0b3Iub29sVHlwZSAhPT0gT29sVHlwZXMuTW9kaWZpZXIuVkFMSURBVE9SKSB7XG4gICAgICAgICAgICAvL2NvbmZsaWN0IHdpdGggZXhpc3RpbmcgdmFyaWFibGVzLCBuZWVkIHRvIHJlbmFtZSB0byBhbm90aGVyIHZhcmlhYmxlXG4gICAgICAgICAgICBsZXQgY291bnRlciA9IDE7XG4gICAgICAgICAgICBkbyB7XG4gICAgICAgICAgICAgICAgY291bnRlcisrOyAgICAgICBcbiAgICAgICAgICAgICAgICB0YXJnZXRWYXJOYW1lID0gdmFsdWUubmFtZSArIGNvdW50ZXIudG9TdHJpbmcoKTsgICAgICAgICBcbiAgICAgICAgICAgIH0gd2hpbGUgKGNvbXBpbGVDb250ZXh0LnZhcmlhYmxlcy5oYXNPd25Qcm9wZXJ0eSh0YXJnZXRWYXJOYW1lKSk7ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGNvbXBpbGVDb250ZXh0LnZhcmlhYmxlc1t0YXJnZXRWYXJOYW1lXSA9IHsgdHlwZTogJ2xvY2FsVmFyaWFibGUnLCBzb3VyY2U6ICdtb2RpZmllcicgfTtcbiAgICAgICAgICAgIG5lZWREZWNsYXJlID0gdHJ1ZTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vaWYgKGNvbXBpbGVDb250ZXh0LnZhcmlhYmxlc1tdKVxuXG4gICAgICAgIGFkZENvZGVCbG9jayhjb21waWxlQ29udGV4dCwgdG9wb0lkLCB7XG4gICAgICAgICAgICB0eXBlOiBPT0xfTU9ESUZJRVJfQ09ERV9GTEFHW2Z1bmN0b3Iub29sVHlwZV0sXG4gICAgICAgICAgICB0YXJnZXQ6IHRhcmdldFZhck5hbWUsXG4gICAgICAgICAgICByZWZlcmVuY2VzLCAgIC8vIGxhdGVzdC4sIGV4c2l0aW5nLiwgcmF3LlxuICAgICAgICAgICAgbmVlZERlY2xhcmVcbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgcmV0dXJuIHRvcG9JZDtcbn0gIFxuICAgICAgXG5mdW5jdGlvbiBleHRyYWN0UmVmZXJlbmNlZEZpZWxkcyhvb2xBcmdzKSB7ICAgXG4gICAgb29sQXJncyA9IF8uY2FzdEFycmF5KG9vbEFyZ3MpOyAgICBcblxuICAgIGxldCByZWZzID0gW107XG5cbiAgICBvb2xBcmdzLmZvckVhY2goYSA9PiB7XG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KGEpKSB7XG4gICAgICAgICAgICByZWZzID0gcmVmcy5jb25jYXQoZXh0cmFjdFJlZmVyZW5jZWRGaWVsZHMoYSkpO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9IFxuXG4gICAgICAgIGxldCByZXN1bHQgPSBjaGVja1JlZmVyZW5jZVRvRmllbGQoYSk7XG4gICAgICAgIGlmIChyZXN1bHQpIHtcbiAgICAgICAgICAgIHJlZnMucHVzaChyZXN1bHQpO1xuICAgICAgICB9XG4gICAgfSk7XG5cbiAgICByZXR1cm4gcmVmcztcbn1cblxuZnVuY3Rpb24gY2hlY2tSZWZlcmVuY2VUb0ZpZWxkKG9iaikge1xuICAgIGlmIChfLmlzUGxhaW5PYmplY3Qob2JqKSAmJiBvYmoub29sVHlwZSkge1xuICAgICAgICBpZiAob2JqLm9vbFR5cGUgPT09ICdQaXBlZFZhbHVlJykgcmV0dXJuIGNoZWNrUmVmZXJlbmNlVG9GaWVsZChvYmoudmFsdWUpO1xuICAgICAgICBpZiAob2JqLm9vbFR5cGUgPT09ICdPYmplY3RSZWZlcmVuY2UnKSB7XG4gICAgICAgICAgICByZXR1cm4gb2JqLm5hbWU7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICByZXR1cm4gdW5kZWZpbmVkO1xufVxuXG5mdW5jdGlvbiBhZGRNb2RpZmllclRvTWFwKGZ1bmN0b3JJZCwgZnVuY3RvclR5cGUsIGZ1bmN0b3JKc0ZpbGUsIG1hcE9mRnVuY3RvclRvRmlsZSkge1xuICAgIGlmIChtYXBPZkZ1bmN0b3JUb0ZpbGVbZnVuY3RvcklkXSAmJiBtYXBPZkZ1bmN0b3JUb0ZpbGVbZnVuY3RvcklkXSAhPT0gZnVuY3RvckpzRmlsZSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYENvbmZsaWN0OiAke2Z1bmN0b3JUeXBlfSBuYW1pbmcgXCIke2Z1bmN0b3JJZH1cIiBjb25mbGljdHMhYCk7XG4gICAgfVxuICAgIG1hcE9mRnVuY3RvclRvRmlsZVtmdW5jdG9ySWRdID0gZnVuY3RvckpzRmlsZTtcbn1cblxuLyoqXG4gKiBDaGVjayB3aGV0aGVyIGEgZnVuY3RvciBpcyB1c2VyLWRlZmluZWQgb3IgYnVpbHQtaW5cbiAqIEBwYXJhbSBmdW5jdG9yXG4gKiBAcGFyYW0gY29tcGlsZUNvbnRleHRcbiAqIEBwYXJhbSBhcmdzIC0gVXNlZCB0byBtYWtlIHVwIHRoZSBmdW5jdGlvbiBzaWduYXR1cmVcbiAqIEByZXR1cm5zIHtzdHJpbmd9IGZ1bmN0b3IgaWRcbiAqL1xuZnVuY3Rpb24gdHJhbnNsYXRlTW9kaWZpZXIoZnVuY3RvciwgY29tcGlsZUNvbnRleHQsIGFyZ3MpIHtcbiAgICBsZXQgZnVuY3Rpb25OYW1lLCBmaWxlTmFtZSwgZnVuY3RvcklkO1xuXG4gICAgLy9leHRyYWN0IHZhbGlkYXRvciBuYW1pbmcgYW5kIGltcG9ydCBpbmZvcm1hdGlvblxuICAgIGlmIChpc0RvdFNlcGFyYXRlTmFtZShmdW5jdG9yLm5hbWUpKSB7XG4gICAgICAgIGxldCBuYW1lcyA9IGV4dHJhY3REb3RTZXBhcmF0ZU5hbWUoZnVuY3Rvci5uYW1lKTtcbiAgICAgICAgaWYgKG5hbWVzLmxlbmd0aCA+IDIpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignTm90IHN1cHBvcnRlZCByZWZlcmVuY2UgdHlwZTogJyArIGZ1bmN0b3IubmFtZSk7XG4gICAgICAgIH1cblxuICAgICAgICAvL3JlZmVyZW5jZSB0byBvdGhlciBlbnRpdHkgZmlsZVxuICAgICAgICBsZXQgcmVmRW50aXR5TmFtZSA9IG5hbWVzWzBdO1xuICAgICAgICBmdW5jdGlvbk5hbWUgPSBuYW1lc1sxXTtcbiAgICAgICAgZmlsZU5hbWUgPSAnLi8nICsgT09MX01PRElGSUVSX1BBVEhbZnVuY3Rvci5vb2xUeXBlXSArICcvJyArIHJlZkVudGl0eU5hbWUgKyAnLScgKyBmdW5jdGlvbk5hbWUgKyAnLmpzJztcbiAgICAgICAgZnVuY3RvcklkID0gcmVmRW50aXR5TmFtZSArIF8udXBwZXJGaXJzdChmdW5jdGlvbk5hbWUpO1xuICAgICAgICBhZGRNb2RpZmllclRvTWFwKGZ1bmN0b3JJZCwgZnVuY3Rvci5vb2xUeXBlLCBmaWxlTmFtZSwgY29tcGlsZUNvbnRleHQubWFwT2ZGdW5jdG9yVG9GaWxlKTtcblxuICAgIH0gZWxzZSB7XG4gICAgICAgIGZ1bmN0aW9uTmFtZSA9IGZ1bmN0b3IubmFtZTtcblxuICAgICAgICBsZXQgYnVpbHRpbnMgPSBPT0xfTU9ESUZJRVJfQlVJTFRJTltmdW5jdG9yLm9vbFR5cGVdO1xuXG4gICAgICAgIGlmICghKGZ1bmN0aW9uTmFtZSBpbiBidWlsdGlucykpIHtcbiAgICAgICAgICAgIGZpbGVOYW1lID0gJy4vJyArIE9PTF9NT0RJRklFUl9QQVRIW2Z1bmN0b3Iub29sVHlwZV0gKyAnLycgKyBjb21waWxlQ29udGV4dC5tb2R1bGVOYW1lICsgJy0nICsgZnVuY3Rpb25OYW1lICsgJy5qcyc7XG4gICAgICAgICAgICBmdW5jdG9ySWQgPSBmdW5jdGlvbk5hbWU7XG5cbiAgICAgICAgICAgIGlmICghY29tcGlsZUNvbnRleHQubWFwT2ZGdW5jdG9yVG9GaWxlW2Z1bmN0b3JJZF0pIHtcbiAgICAgICAgICAgICAgICBjb21waWxlQ29udGV4dC5uZXdGdW5jdG9yRmlsZXMucHVzaCh7XG4gICAgICAgICAgICAgICAgICAgIGZ1bmN0aW9uTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgZnVuY3RvclR5cGU6IGZ1bmN0b3Iub29sVHlwZSxcbiAgICAgICAgICAgICAgICAgICAgZmlsZU5hbWUsXG4gICAgICAgICAgICAgICAgICAgIGFyZ3NcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYWRkTW9kaWZpZXJUb01hcChmdW5jdG9ySWQsIGZ1bmN0b3Iub29sVHlwZSwgZmlsZU5hbWUsIGNvbXBpbGVDb250ZXh0Lm1hcE9mRnVuY3RvclRvRmlsZSk7ICAgICAgICAgICAgXG4gICAgICAgIH0gZWxzZSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBmdW5jdG9ySWQgPSBmdW5jdG9yLm9vbFR5cGUgKyAncy4nICsgZnVuY3Rpb25OYW1lO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgcmV0dXJuIGZ1bmN0b3JJZDtcbn1cblxuLyoqXG4gKiBDb21waWxlIGEgcGlwZWQgdmFsdWUgZnJvbSBvb2wgdG8gYXN0LlxuICogQHBhcmFtIHtzdHJpbmd9IHN0YXJ0VG9wb0lkIC0gVGhlIHRvcG9sb2dpY2FsIGlkIG9mIHRoZSBzdGFydGluZyBwcm9jZXNzIHRvIHRoZSB0YXJnZXQgdmFsdWUsIGRlZmF1bHQgYXMgdGhlIHBhcmFtIG5hbWVcbiAqIEBwYXJhbSB7b2JqZWN0fSB2YXJPb2wgLSBUYXJnZXQgdmFsdWUgb29sIG5vZGUuXG4gKiBAcGFyYW0ge29iamVjdH0gY29tcGlsZUNvbnRleHQgLSBDb21waWxhdGlvbiBjb250ZXh0LlxuICogQHByb3BlcnR5IHtzdHJpbmd9IGNvbXBpbGVDb250ZXh0Lm1vZHVsZU5hbWVcbiAqIEBwcm9wZXJ0eSB7VG9wb1NvcnR9IGNvbXBpbGVDb250ZXh0LnRvcG9Tb3J0XG4gKiBAcHJvcGVydHkge29iamVjdH0gY29tcGlsZUNvbnRleHQuYXN0TWFwIC0gVG9wbyBJZCB0byBhc3QgbWFwXG4gKiBAcmV0dXJucyB7c3RyaW5nfSBMYXN0IHRvcG8gSWRcbiAqL1xuZnVuY3Rpb24gY29tcGlsZVBpcGVkVmFsdWUoc3RhcnRUb3BvSWQsIHZhck9vbCwgY29tcGlsZUNvbnRleHQpIHtcbiAgICBsZXQgbGFzdFRvcG9JZCA9IGNvbXBpbGVDb25jcmV0ZVZhbHVlRXhwcmVzc2lvbihzdGFydFRvcG9JZCwgdmFyT29sLnZhbHVlLCBjb21waWxlQ29udGV4dCk7XG5cbiAgICB2YXJPb2wubW9kaWZpZXJzLmZvckVhY2gobW9kaWZpZXIgPT4ge1xuICAgICAgICBsZXQgbW9kaWZpZXJTdGFydFRvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgc3RhcnRUb3BvSWQgKyBPT0xfTU9ESUZJRVJfT1BbbW9kaWZpZXIub29sVHlwZV0gKyBtb2RpZmllci5uYW1lKTtcbiAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBsYXN0VG9wb0lkLCBtb2RpZmllclN0YXJ0VG9wb0lkKTtcblxuICAgICAgICBsYXN0VG9wb0lkID0gY29tcGlsZU1vZGlmaWVyKFxuICAgICAgICAgICAgbW9kaWZpZXJTdGFydFRvcG9JZCxcbiAgICAgICAgICAgIHZhck9vbC52YWx1ZSxcbiAgICAgICAgICAgIG1vZGlmaWVyLFxuICAgICAgICAgICAgY29tcGlsZUNvbnRleHRcbiAgICAgICAgKTtcbiAgICB9KTtcblxuICAgIHJldHVybiBsYXN0VG9wb0lkO1xufVxuXG4vKipcbiAqIENvbXBpbGUgYSB2YXJpYWJsZSByZWZlcmVuY2UgZnJvbSBvb2wgdG8gYXN0LlxuICogQHBhcmFtIHtzdHJpbmd9IHN0YXJ0VG9wb0lkIC0gVGhlIHRvcG9sb2dpY2FsIGlkIG9mIHRoZSBzdGFydGluZyBwcm9jZXNzIHRvIHRoZSB0YXJnZXQgdmFsdWUsIGRlZmF1bHQgYXMgdGhlIHBhcmFtIG5hbWVcbiAqIEBwYXJhbSB7b2JqZWN0fSB2YXJPb2wgLSBUYXJnZXQgdmFsdWUgb29sIG5vZGUuXG4gKiBAcGFyYW0ge29iamVjdH0gY29tcGlsZUNvbnRleHQgLSBDb21waWxhdGlvbiBjb250ZXh0LlxuICogQHByb3BlcnR5IHtzdHJpbmd9IGNvbXBpbGVDb250ZXh0Lm1vZHVsZU5hbWVcbiAqIEBwcm9wZXJ0eSB7VG9wb1NvcnR9IGNvbXBpbGVDb250ZXh0LnRvcG9Tb3J0XG4gKiBAcHJvcGVydHkge29iamVjdH0gY29tcGlsZUNvbnRleHQuYXN0TWFwIC0gVG9wbyBJZCB0byBhc3QgbWFwXG4gKiBAcmV0dXJucyB7c3RyaW5nfSBMYXN0IHRvcG8gSWRcbiAqL1xuZnVuY3Rpb24gY29tcGlsZVZhcmlhYmxlUmVmZXJlbmNlKHN0YXJ0VG9wb0lkLCB2YXJPb2wsIGNvbXBpbGVDb250ZXh0KSB7XG4gICAgcHJlOiBfLmlzUGxhaW5PYmplY3QodmFyT29sKSAmJiB2YXJPb2wub29sVHlwZSA9PT0gJ09iamVjdFJlZmVyZW5jZSc7XG5cbiAgICAvL2xldCBbIGJhc2VOYW1lLCBvdGhlcnMgXSA9IHZhck9vbC5uYW1lLnNwbGl0KCcuJywgMik7XG4gICAgLypcbiAgICBpZiAoY29tcGlsZUNvbnRleHQubW9kZWxWYXJzICYmIGNvbXBpbGVDb250ZXh0Lm1vZGVsVmFycy5oYXMoYmFzZU5hbWUpICYmIG90aGVycykge1xuICAgICAgICB2YXJPb2wubmFtZSA9IGJhc2VOYW1lICsgJy5kYXRhJyArICcuJyArIG90aGVycztcbiAgICB9Ki8gICAgXG5cbiAgICAvL3NpbXBsZSB2YWx1ZVxuICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtzdGFydFRvcG9JZF0gPSBKc0xhbmcuYXN0VmFsdWUodmFyT29sKTtcbiAgICByZXR1cm4gc3RhcnRUb3BvSWQ7XG59XG5cbi8qKlxuICogR2V0IGFuIGFycmF5IG9mIHBhcmFtZXRlciBuYW1lcy5cbiAqIEBwYXJhbSB7YXJyYXl9IGFyZ3MgLSBBbiBhcnJheSBvZiBhcmd1bWVudHMgaW4gb29sIHN5bnRheFxuICogQHJldHVybnMge2FycmF5fVxuICovXG5mdW5jdGlvbiB0cmFuc2xhdGVGdW5jdGlvblBhcmFtcyhhcmdzKSB7XG4gICAgaWYgKF8uaXNFbXB0eShhcmdzKSkgcmV0dXJuIFtdO1xuXG4gICAgbGV0IG5hbWVzID0gbmV3IFNldCgpO1xuXG4gICAgZnVuY3Rpb24gdHJhbnNsYXRlRnVuY3Rpb25QYXJhbShhcmcsIGkpIHtcbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChhcmcpKSB7XG4gICAgICAgICAgICBpZiAoYXJnLm9vbFR5cGUgPT09ICdQaXBlZFZhbHVlJykge1xuICAgICAgICAgICAgICAgIHJldHVybiB0cmFuc2xhdGVGdW5jdGlvblBhcmFtKGFyZy52YWx1ZSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChhcmcub29sVHlwZSA9PT0gJ09iamVjdFJlZmVyZW5jZScpIHtcbiAgICAgICAgICAgICAgICBpZiAoaXNEb3RTZXBhcmF0ZU5hbWUoYXJnLm5hbWUpKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBleHRyYWN0RG90U2VwYXJhdGVOYW1lKGFyZy5uYW1lKS5wb3AoKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIHJldHVybiBhcmcubmFtZTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiAncGFyYW0nICsgKGkgKyAxKS50b1N0cmluZygpO1xuICAgIH1cblxuICAgIHJldHVybiBfLm1hcChhcmdzLCAoYXJnLCBpKSA9PiB7XG4gICAgICAgIGxldCBiYXNlTmFtZSA9IHRyYW5zbGF0ZUZ1bmN0aW9uUGFyYW0oYXJnLCBpKTtcbiAgICAgICAgbGV0IG5hbWUgPSBiYXNlTmFtZTtcbiAgICAgICAgbGV0IGNvdW50ID0gMjtcbiAgICAgICAgXG4gICAgICAgIHdoaWxlIChuYW1lcy5oYXMobmFtZSkpIHtcbiAgICAgICAgICAgIG5hbWUgPSBiYXNlTmFtZSArIGNvdW50LnRvU3RyaW5nKCk7XG4gICAgICAgICAgICBjb3VudCsrO1xuICAgICAgICB9XG5cbiAgICAgICAgbmFtZXMuYWRkKG5hbWUpO1xuICAgICAgICByZXR1cm4gbmFtZTsgICAgICAgIFxuICAgIH0pO1xufVxuXG4vKipcbiAqIENvbXBpbGUgYSBjb25jcmV0ZSB2YWx1ZSBleHByZXNzaW9uIGZyb20gb29sIHRvIGFzdFxuICogQHBhcmFtIHtzdHJpbmd9IHN0YXJ0VG9wb0lkIC0gVGhlIHRvcG8gaWQgb2YgdGhlIHN0YXJ0aW5nIHByb2Nlc3MgdG8gdGhlIHRhcmdldCB2YWx1ZSBleHByZXNzaW9uXG4gKiBAcGFyYW0ge29iamVjdH0gdmFsdWUgLSBPb2wgbm9kZVxuICogQHBhcmFtIHtvYmplY3R9IGNvbXBpbGVDb250ZXh0IC0gQ29tcGlsYXRpb24gY29udGV4dFxuICogQHJldHVybnMge3N0cmluZ30gTGFzdCB0b3BvSWRcbiAqL1xuZnVuY3Rpb24gY29tcGlsZUNvbmNyZXRlVmFsdWVFeHByZXNzaW9uKHN0YXJ0VG9wb0lkLCB2YWx1ZSwgY29tcGlsZUNvbnRleHQpIHtcbiAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHZhbHVlKSkge1xuICAgICAgICBpZiAodmFsdWUub29sVHlwZSA9PT0gJ1BpcGVkVmFsdWUnKSB7XG4gICAgICAgICAgICByZXR1cm4gY29tcGlsZVBpcGVkVmFsdWUoc3RhcnRUb3BvSWQsIHZhbHVlLCBjb21waWxlQ29udGV4dCk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAodmFsdWUub29sVHlwZSA9PT0gJ09iamVjdFJlZmVyZW5jZScpIHtcbiAgICAgICAgICAgIGxldCBbIHJlZkJhc2UsIC4uLnJlc3QgXSA9IGV4dHJhY3REb3RTZXBhcmF0ZU5hbWUodmFsdWUubmFtZSk7XG5cbiAgICAgICAgICAgIGxldCBkZXBlbmRlbmN5O1xuXG4gICAgICAgICAgICBpZiAoIWNvbXBpbGVDb250ZXh0LnZhcmlhYmxlc1tyZWZCYXNlXSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgUmVmZXJlbmNlZCB1bmRlZmluZWQgdmFyaWFibGU6ICR7dmFsdWUubmFtZX1gKTsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICBpZiAoY29tcGlsZUNvbnRleHQudmFyaWFibGVzW3JlZkJhc2VdLnR5cGUgPT09ICdlbnRpdHknICYmICFjb21waWxlQ29udGV4dC52YXJpYWJsZXNbcmVmQmFzZV0ub25nb2luZykge1xuICAgICAgICAgICAgICAgIGRlcGVuZGVuY3kgPSByZWZCYXNlO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChyZWZCYXNlID09PSAnbGF0ZXN0JyAmJiByZXN0Lmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgICAgICAvL2xhdGVzdC5wYXNzd29yZFxuICAgICAgICAgICAgICAgIGxldCByZWZGaWVsZE5hbWUgPSByZXN0LnBvcCgpO1xuICAgICAgICAgICAgICAgIGlmIChyZWZGaWVsZE5hbWUgIT09IHN0YXJ0VG9wb0lkKSB7XG4gICAgICAgICAgICAgICAgICAgIGRlcGVuZGVuY3kgPSByZWZGaWVsZE5hbWUgKyAnOnJlYWR5JztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2UgaWYgKF8uaXNFbXB0eShyZXN0KSkge1xuICAgICAgICAgICAgICAgIGRlcGVuZGVuY3kgPSByZWZCYXNlICsgJzpyZWFkeSc7XG4gICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICBpZiAoZGVwZW5kZW5jeSkge1xuICAgICAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgZGVwZW5kZW5jeSwgc3RhcnRUb3BvSWQpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gY29tcGlsZVZhcmlhYmxlUmVmZXJlbmNlKHN0YXJ0VG9wb0lkLCB2YWx1ZSwgY29tcGlsZUNvbnRleHQpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHZhbHVlLm9vbFR5cGUgPT09ICdSZWdFeHAnKSB7XG4gICAgICAgICAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbc3RhcnRUb3BvSWRdID0gSnNMYW5nLmFzdFZhbHVlKHZhbHVlKTsgICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiBzdGFydFRvcG9JZDtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICh2YWx1ZS5vb3JUeXBlID09PSAnU3ltYm9sVG9rZW4nKSB7XG4gICAgICAgICAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbc3RhcnRUb3BvSWRdID0gSnNMYW5nLmFzdFZhbHVlKHRyYW5zbGF0ZVN5bWJvbFRva2VuKHZhbHVlLm5hbWUpKTsgICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiBzdGFydFRvcG9JZDtcbiAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgdmFsdWUgPSBfLm1hcFZhbHVlcyh2YWx1ZSwgKHZhbHVlT2ZFbGVtZW50LCBrZXkpID0+IHsgXG4gICAgICAgICAgICBsZXQgc2lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCArICcuJyArIGtleSk7XG4gICAgICAgICAgICBsZXQgZWlkID0gY29tcGlsZUNvbmNyZXRlVmFsdWVFeHByZXNzaW9uKHNpZCwgdmFsdWVPZkVsZW1lbnQsIGNvbXBpbGVDb250ZXh0KTtcbiAgICAgICAgICAgIGlmIChzaWQgIT09IGVpZCkge1xuICAgICAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgZWlkLCBzdGFydFRvcG9JZCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gY29tcGlsZUNvbnRleHQuYXN0TWFwW2VpZF07XG4gICAgICAgIH0pO1xuICAgIH0gZWxzZSBpZiAoQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHtcbiAgICAgICAgdmFsdWUgPSBfLm1hcCh2YWx1ZSwgKHZhbHVlT2ZFbGVtZW50LCBpbmRleCkgPT4geyBcbiAgICAgICAgICAgIGxldCBzaWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkICsgJ1snICsgaW5kZXggKyAnXScpO1xuICAgICAgICAgICAgbGV0IGVpZCA9IGNvbXBpbGVDb25jcmV0ZVZhbHVlRXhwcmVzc2lvbihzaWQsIHZhbHVlT2ZFbGVtZW50LCBjb21waWxlQ29udGV4dCk7XG4gICAgICAgICAgICBpZiAoc2lkICE9PSBlaWQpIHtcbiAgICAgICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIGVpZCwgc3RhcnRUb3BvSWQpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtlaWRdO1xuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbc3RhcnRUb3BvSWRdID0gSnNMYW5nLmFzdFZhbHVlKHZhbHVlKTtcbiAgICByZXR1cm4gc3RhcnRUb3BvSWQ7XG59XG5cbmZ1bmN0aW9uIHRyYW5zbGF0ZVN5bWJvbFRva2VuKG5hbWUpIHtcbiAgICBpZiAobmFtZSA9PT0gJ25vdycpIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIFwidHlwZVwiOiBcIkNhbGxFeHByZXNzaW9uXCIsXG4gICAgICAgICAgICBcImNhbGxlZVwiOiB7XG4gICAgICAgICAgICAgICAgXCJ0eXBlXCI6IFwiTWVtYmVyRXhwcmVzc2lvblwiLFxuICAgICAgICAgICAgICAgIFwiY29tcHV0ZWRcIjogZmFsc2UsXG4gICAgICAgICAgICAgICAgXCJvYmplY3RcIjoge1xuICAgICAgICAgICAgICAgICAgICBcInR5cGVcIjogXCJNZW1iZXJFeHByZXNzaW9uXCIsXG4gICAgICAgICAgICAgICAgICAgIFwiY29tcHV0ZWRcIjogZmFsc2UsXG4gICAgICAgICAgICAgICAgICAgIFwib2JqZWN0XCI6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIFwidHlwZVwiOiBcIk1lbWJlckV4cHJlc3Npb25cIixcbiAgICAgICAgICAgICAgICAgICAgICAgIFwiY29tcHV0ZWRcIjogZmFsc2UsXG4gICAgICAgICAgICAgICAgICAgICAgICBcIm9iamVjdFwiOiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXCJ0eXBlXCI6IFwiSWRlbnRpZmllclwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFwibmFtZVwiOiBcIlR5cGVzXCJcbiAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICBcInByb3BlcnR5XCI6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcInR5cGVcIjogXCJJZGVudGlmaWVyXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXCJuYW1lXCI6IFwiREFURVRJTUVcIlxuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICBcInByb3BlcnR5XCI6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIFwidHlwZVwiOiBcIklkZW50aWZpZXJcIixcbiAgICAgICAgICAgICAgICAgICAgICAgIFwibmFtZVwiOiBcInR5cGVPYmplY3RcIlxuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICBcInByb3BlcnR5XCI6IHtcbiAgICAgICAgICAgICAgICAgICAgXCJ0eXBlXCI6IFwiSWRlbnRpZmllclwiLFxuICAgICAgICAgICAgICAgICAgICBcIm5hbWVcIjogXCJsb2NhbFwiXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIFwiYXJndW1lbnRzXCI6IFtdXG4gICAgICAgIH07XG4gICAgfSBcbiAgICBcbiAgICB0aHJvdyBuZXcgRXJyb3IoJ25vdCBzdXBwb3J0Jyk7XG59XG5cbi8qKlxuICogVHJhbnNsYXRlIGFuIGFycmF5IG9mIGZ1bmN0aW9uIGFyZ3VtZW50cyBmcm9tIG9vbCBpbnRvIGFzdC5cbiAqIEBwYXJhbSB0b3BvSWQgLSBUaGUgbW9kaWZpZXIgZnVuY3Rpb24gdG9wbyBcbiAqIEBwYXJhbSBhcmdzIC0gXG4gKiBAcGFyYW0gY29tcGlsZUNvbnRleHQgLSBcbiAqIEByZXR1cm5zIHtBcnJheX1cbiAqL1xuZnVuY3Rpb24gdHJhbnNsYXRlQXJncyh0b3BvSWQsIGFyZ3MsIGNvbXBpbGVDb250ZXh0KSB7XG4gICAgYXJncyA9IF8uY2FzdEFycmF5KGFyZ3MpO1xuICAgIGlmIChfLmlzRW1wdHkoYXJncykpIHJldHVybiBbXTtcblxuICAgIGxldCBjYWxsQXJncyA9IFtdO1xuXG4gICAgXy5lYWNoKGFyZ3MsIChhcmcsIGkpID0+IHsgICAgICAgICAgICAgICAgXG4gICAgICAgIGxldCBhcmdUb3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIHRvcG9JZCArICc6YXJnWycgKyAoaSsxKS50b1N0cmluZygpICsgJ10nKTtcbiAgICAgICAgbGV0IGxhc3RUb3BvSWQgPSBjb21waWxlQ29uY3JldGVWYWx1ZUV4cHJlc3Npb24oYXJnVG9wb0lkLCBhcmcsIGNvbXBpbGVDb250ZXh0KTtcblxuICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIGxhc3RUb3BvSWQsIHRvcG9JZCk7XG5cbiAgICAgICAgY2FsbEFyZ3MgPSBjYWxsQXJncy5jb25jYXQoXy5jYXN0QXJyYXkoZ2V0Q29kZVJlcHJlc2VudGF0aW9uT2YobGFzdFRvcG9JZCwgY29tcGlsZUNvbnRleHQpKSk7XG4gICAgfSk7XG5cbiAgICByZXR1cm4gY2FsbEFyZ3M7XG59XG5cbi8qKlxuICogQ29tcGlsZSBhIHBhcmFtIG9mIGludGVyZmFjZSBmcm9tIG9vbCBpbnRvIGFzdFxuICogQHBhcmFtIGluZGV4XG4gKiBAcGFyYW0gcGFyYW1cbiAqIEBwYXJhbSBjb21waWxlQ29udGV4dFxuICogQHJldHVybnMge3N0cmluZ31cbiAqL1xuZnVuY3Rpb24gY29tcGlsZVBhcmFtKGluZGV4LCBwYXJhbSwgY29tcGlsZUNvbnRleHQpIHtcbiAgICBsZXQgdHlwZSA9IHBhcmFtLnR5cGU7ICAgIFxuXG4gICAgbGV0IHR5cGVPYmplY3QgPSBUeXBlc1t0eXBlXTtcblxuICAgIGlmICghdHlwZU9iamVjdCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1Vua25vd24gZmllbGQgdHlwZTogJyArIHR5cGUpO1xuICAgIH1cblxuICAgIGxldCBzYW5pdGl6ZXJOYW1lID0gYFR5cGVzLiR7dHlwZS50b1VwcGVyQ2FzZSgpfS5zYW5pdGl6ZWA7XG5cbiAgICBsZXQgdmFyUmVmID0gSnNMYW5nLmFzdFZhclJlZihwYXJhbS5uYW1lKTtcbiAgICBsZXQgY2FsbEFzdCA9IEpzTGFuZy5hc3RDYWxsKHNhbml0aXplck5hbWUsIFt2YXJSZWYsIEpzTGFuZy5hc3RBcnJheUFjY2VzcygnJG1ldGEucGFyYW1zJywgaW5kZXgpLCBKc0xhbmcuYXN0VmFyUmVmKCd0aGlzLmRiLmkxOG4nKV0pO1xuXG4gICAgbGV0IHByZXBhcmVUb3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsICckcGFyYW1zOnNhbml0aXplWycgKyBpbmRleC50b1N0cmluZygpICsgJ10nKTtcbiAgICAvL2xldCBzYW5pdGl6ZVN0YXJ0aW5nO1xuXG4gICAgLy9pZiAoaW5kZXggPT09IDApIHtcbiAgICAgICAgLy9kZWNsYXJlICRzYW5pdGl6ZVN0YXRlIHZhcmlhYmxlIGZvciB0aGUgZmlyc3QgdGltZVxuICAgIC8vICAgIHNhbml0aXplU3RhcnRpbmcgPSBKc0xhbmcuYXN0VmFyRGVjbGFyZSh2YXJSZWYsIGNhbGxBc3QsIGZhbHNlLCBmYWxzZSwgYFNhbml0aXplIHBhcmFtIFwiJHtwYXJhbS5uYW1lfVwiYCk7XG4gICAgLy99IGVsc2Uge1xuICAgIC8vbGV0IHNhbml0aXplU3RhcnRpbmcgPSA7XG5cbiAgICAgICAgLy9sZXQgbGFzdFByZXBhcmVUb3BvSWQgPSAnJHBhcmFtczpzYW5pdGl6ZVsnICsgKGluZGV4IC0gMSkudG9TdHJpbmcoKSArICddJztcbiAgICAgICAgLy9kZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIGxhc3RQcmVwYXJlVG9wb0lkLCBwcmVwYXJlVG9wb0lkKTtcbiAgICAvL31cblxuICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtwcmVwYXJlVG9wb0lkXSA9IFtcbiAgICAgICAgSnNMYW5nLmFzdEFzc2lnbih2YXJSZWYsIGNhbGxBc3QsIGBTYW5pdGl6ZSBhcmd1bWVudCBcIiR7cGFyYW0ubmFtZX1cImApXG4gICAgXTtcblxuICAgIGFkZENvZGVCbG9jayhjb21waWxlQ29udGV4dCwgcHJlcGFyZVRvcG9JZCwge1xuICAgICAgICB0eXBlOiBBU1RfQkxLX1BBUkFNX1NBTklUSVpFXG4gICAgfSk7XG5cbiAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIHByZXBhcmVUb3BvSWQsIGNvbXBpbGVDb250ZXh0Lm1haW5TdGFydElkKTtcblxuICAgIGxldCB0b3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIHBhcmFtLm5hbWUpO1xuICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgY29tcGlsZUNvbnRleHQubWFpblN0YXJ0SWQsIHRvcG9JZCk7XG5cbiAgICBsZXQgdmFsdWUgPSB3cmFwUGFyYW1SZWZlcmVuY2UocGFyYW0ubmFtZSwgcGFyYW0pO1xuICAgIGxldCBlbmRUb3BvSWQgPSBjb21waWxlVmFyaWFibGVSZWZlcmVuY2UodG9wb0lkLCB2YWx1ZSwgY29tcGlsZUNvbnRleHQpO1xuXG4gICAgbGV0IHJlYWR5VG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCB0b3BvSWQgKyAnOnJlYWR5Jyk7XG4gICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBlbmRUb3BvSWQsIHJlYWR5VG9wb0lkKTtcblxuICAgIHJldHVybiByZWFkeVRvcG9JZDtcbn1cblxuLyoqXG4gKiBDb21waWxlIGEgbW9kZWwgZmllbGQgcHJlcHJvY2VzcyBpbmZvcm1hdGlvbiBpbnRvIGFzdC5cbiAqIEBwYXJhbSB7b2JqZWN0fSBwYXJhbSAtIEZpZWxkIGluZm9ybWF0aW9uXG4gKiBAcGFyYW0ge29iamVjdH0gY29tcGlsZUNvbnRleHQgLSBDb21waWxhdGlvbiBjb250ZXh0XG4gKiBAcmV0dXJucyB7c3RyaW5nfVxuICovXG5mdW5jdGlvbiBjb21waWxlRmllbGQocGFyYW1OYW1lLCBwYXJhbSwgY29tcGlsZUNvbnRleHQpIHtcbiAgICAvLyAxLiByZWZlcmVuY2UgdG8gdGhlIGxhdGVzdCBvYmplY3QgdGhhdCBpcyBwYXNzZWQgcXVhbGlmaWVyIGNoZWNrc1xuICAgIC8vIDIuIGlmIG1vZGlmaWVycyBleGlzdCwgd3JhcCB0aGUgcmVmIGludG8gYSBwaXBlZCB2YWx1ZVxuICAgIC8vIDMuIHByb2Nlc3MgdGhlIHJlZiAob3IgcGlwZWQgcmVmKSBhbmQgbWFyayBhcyBlbmRcbiAgICAvLyA0LiBidWlsZCBkZXBlbmRlbmNpZXM6IGxhdGVzdC5maWVsZCAtPiAuLi4gLT4gZmllbGQ6cmVhZHkgXG4gICAgbGV0IHRvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgcGFyYW1OYW1lKTtcbiAgICBsZXQgY29udGV4dE5hbWUgPSAnbGF0ZXN0LicgKyBwYXJhbU5hbWU7XG4gICAgLy9jb21waWxlQ29udGV4dC5hc3RNYXBbdG9wb0lkXSA9IEpzTGFuZy5hc3RWYXJSZWYoY29udGV4dE5hbWUsIHRydWUpO1xuXG4gICAgbGV0IHZhbHVlID0gd3JhcFBhcmFtUmVmZXJlbmNlKGNvbnRleHROYW1lLCBwYXJhbSk7ICAgIFxuICAgIGxldCBlbmRUb3BvSWQgPSBjb21waWxlQ29uY3JldGVWYWx1ZUV4cHJlc3Npb24odG9wb0lkLCB2YWx1ZSwgY29tcGlsZUNvbnRleHQpO1xuXG4gICAgbGV0IHJlYWR5VG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCB0b3BvSWQgKyAnOnJlYWR5Jyk7XG4gICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBlbmRUb3BvSWQsIHJlYWR5VG9wb0lkKTtcblxuICAgIHJldHVybiByZWFkeVRvcG9JZDtcbn1cblxuZnVuY3Rpb24gd3JhcFBhcmFtUmVmZXJlbmNlKG5hbWUsIHZhbHVlKSB7XG4gICAgbGV0IHJlZiA9IE9iamVjdC5hc3NpZ24oeyBvb2xUeXBlOiAnT2JqZWN0UmVmZXJlbmNlJywgbmFtZTogbmFtZSB9KTtcbiAgICBcbiAgICBpZiAoIV8uaXNFbXB0eSh2YWx1ZS5tb2RpZmllcnMpKSB7XG4gICAgICAgIHJldHVybiB7IG9vbFR5cGU6ICdQaXBlZFZhbHVlJywgdmFsdWU6IHJlZiwgbW9kaWZpZXJzOiB2YWx1ZS5tb2RpZmllcnMgfTtcbiAgICB9XG4gICAgXG4gICAgcmV0dXJuIHJlZjtcbn1cblxuZnVuY3Rpb24gaGFzTW9kZWxGaWVsZChvcGVyYW5kLCBjb21waWxlQ29udGV4dCkge1xuICAgIGlmIChfLmlzUGxhaW5PYmplY3Qob3BlcmFuZCkgJiYgb3BlcmFuZC5vb2xUeXBlID09PSAnT2JqZWN0UmVmZXJlbmNlJykge1xuICAgICAgICBsZXQgWyBiYXNlVmFyLCAuLi5yZXN0IF0gPSBvcGVyYW5kLm5hbWUuc3BsaXQoJy4nKTtcblxuICAgICAgICByZXR1cm4gY29tcGlsZUNvbnRleHQudmFyaWFibGVzW2Jhc2VWYXJdICYmIGNvbXBpbGVDb250ZXh0LnZhcmlhYmxlc1tiYXNlVmFyXS5vbmdvaW5nICYmIHJlc3QubGVuZ3RoID4gMDsgICAgICAgIFxuICAgIH1cblxuICAgIHJldHVybiBmYWxzZTsgICAgXG59XG5cbi8qKlxuICogVHJhbnNsYXRlIGEgdGhlbiBjbGF1c2UgZnJvbSBvb2wgaW50byBhc3QgaW4gcmV0dXJuIGJsb2NrLlxuICogQHBhcmFtIHtzdHJpbmd9IHN0YXJ0SWRcbiAqIEBwYXJhbSB7c3RyaW5nfSBlbmRJZFxuICogQHBhcmFtIHRoZW5cbiAqIEBwYXJhbSBjb21waWxlQ29udGV4dFxuICogQHJldHVybnMge29iamVjdH0gQVNUIG9iamVjdFxuICovXG5mdW5jdGlvbiB0cmFuc2xhdGVSZXR1cm5UaGVuQXN0KHN0YXJ0SWQsIGVuZElkLCB0aGVuLCBjb21waWxlQ29udGV4dCkge1xuICAgIGlmIChfLmlzUGxhaW5PYmplY3QodGhlbikpIHtcbiAgICAgICAgaWYgKHRoZW4ub29sVHlwZSA9PT0gJ1Rocm93RXhwcmVzc2lvbicpIHtcbiAgICAgICAgICAgIGxldCBhcmdzO1xuICAgICAgICAgICAgaWYgKHRoZW4uYXJncykge1xuICAgICAgICAgICAgICAgIGFyZ3MgPSB0cmFuc2xhdGVBcmdzKHN0YXJ0SWQsIHRoZW4uYXJncywgY29tcGlsZUNvbnRleHQpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBhcmdzID0gW107XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gSnNMYW5nLmFzdFRocm93KHRoZW4uZXJyb3JUeXBlIHx8IGRlZmF1bHRFcnJvciwgdGhlbi5tZXNzYWdlIHx8IGFyZ3MpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHRoZW4ub29sVHlwZSA9PT0gJ1JldHVybkV4cHJlc3Npb24nKSB7XG4gICAgICAgICAgICByZXR1cm4gdHJhbnNsYXRlUmV0dXJuVmFsdWVBc3Qoc3RhcnRJZCwgZW5kSWQsIHRoZW4udmFsdWUsIGNvbXBpbGVDb250ZXh0KTtcbiAgICAgICAgfSAgICAgICAgXG4gICAgfVxuXG4gICAgLy90aGVuIGV4cHJlc3Npb24gaXMgYW4gb29sb25nIGNvbmNyZXRlIHZhbHVlICAgIFxuICAgIGlmIChfLmlzQXJyYXkodGhlbikgfHwgXy5pc1BsYWluT2JqZWN0KHRoZW4pKSB7XG4gICAgICAgIGxldCB2YWx1ZUVuZElkID0gY29tcGlsZUNvbmNyZXRlVmFsdWVFeHByZXNzaW9uKHN0YXJ0SWQsIHRoZW4sIGNvbXBpbGVDb250ZXh0KTsgICAgXG4gICAgICAgIHRoZW4gPSBjb21waWxlQ29udGV4dC5hc3RNYXBbdmFsdWVFbmRJZF07IFxuICAgIH0gICBcblxuICAgIHJldHVybiBKc0xhbmcuYXN0UmV0dXJuKHRoZW4pO1xufVxuXG4vKipcbiAqIFRyYW5zbGF0ZSBhIHRoZW4gY2xhdXNlIGZyb20gb29sIGludG8gYXN0XG4gKiBAcGFyYW0ge3N0cmluZ30gc3RhcnRJZFxuICogQHBhcmFtIHtzdHJpbmd9IGVuZElkXG4gKiBAcGFyYW0gdGhlblxuICogQHBhcmFtIGNvbXBpbGVDb250ZXh0XG4gKiBAcGFyYW0gYXNzaWduVG9cbiAqIEByZXR1cm5zIHtvYmplY3R9IEFTVCBvYmplY3RcbiAqL1xuZnVuY3Rpb24gdHJhbnNsYXRlVGhlbkFzdChzdGFydElkLCBlbmRJZCwgdGhlbiwgY29tcGlsZUNvbnRleHQsIGFzc2lnblRvKSB7XG4gICAgaWYgKF8uaXNQbGFpbk9iamVjdCh0aGVuKSkge1xuICAgICAgICBpZiAodGhlbi5vb2xUeXBlID09PSAnVGhyb3dFeHByZXNzaW9uJykge1xuICAgICAgICAgICAgbGV0IGFyZ3M7XG4gICAgICAgICAgICBpZiAodGhlbi5hcmdzKSB7XG4gICAgICAgICAgICAgICAgYXJncyA9IHRyYW5zbGF0ZUFyZ3Moc3RhcnRJZCwgdGhlbi5hcmdzLCBjb21waWxlQ29udGV4dCk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGFyZ3MgPSBbXTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiBKc0xhbmcuYXN0VGhyb3codGhlbi5lcnJvclR5cGUgfHwgZGVmYXVsdEVycm9yLCB0aGVuLm1lc3NhZ2UgfHwgYXJncyk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAodGhlbi5vb2xUeXBlID09PSAnTG9naWNhbEV4cHJlc3Npb24nKSB7XG4gICAgICAgICAgICAvKlxuICAgICAgICAgICAgc3dpdGNoICh0aGVuLm9wZXJhdG9yKSB7XG4gICAgICAgICAgICAgICAgY2FzZSAnYW5kJzpcbiAgICAgICAgICAgICAgICAgICAgb3AgPSAnJiYnO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgICAgIGNhc2UgJ29yJzpcbiAgICAgICAgICAgICAgICAgICAgb3AgPSAnfHwnO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5zdXBwb3J0ZWQgdGVzdCBvcGVyYXRvcjogJyArIHRlc3Qub3BlcmF0b3IpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgKi9cbiAgICAgICAgfVxuXG4gICAgICAgIGlmICh0aGVuLm9vbFR5cGUgPT09ICdCaW5hcnlFeHByZXNzaW9uJykge1xuICAgICAgICAgICAgaWYgKCFoYXNNb2RlbEZpZWxkKHRoZW4ubGVmdCwgY29tcGlsZUNvbnRleHQpKSB7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignSW52YWxpZCBxdWVyeSBjb25kaXRpb246IHRoZSBsZWZ0IG9wZXJhbmQgbmVlZCB0byBiZSBhbiBlbnRpdHkgZmllbGQuJyk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChoYXNNb2RlbEZpZWxkKHRoZW4ucmlnaHQsIGNvbXBpbGVDb250ZXh0KSkgeyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ0ludmFsaWQgcXVlcnkgY29uZGl0aW9uOiB0aGUgcmlnaHQgb3BlcmFuZCBzaG91bGQgbm90IGJlIGFuIGVudGl0eSBmaWVsZC4gVXNlIGRhdGFzZXQgaW5zdGVhZCBpZiBqb2luaW5nIGlzIHJlcXVpcmVkLicpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgY29uZGl0aW9uID0ge307XG4gICAgICAgICAgICBsZXQgc3RhcnRSaWdodElkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBzdGFydElkICsgJyRiaW5PcDpyaWdodCcpO1xuICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBzdGFydElkLCBzdGFydFJpZ2h0SWQpO1xuXG4gICAgICAgICAgICBsZXQgbGFzdFJpZ2h0SWQgPSBjb21waWxlQ29uY3JldGVWYWx1ZUV4cHJlc3Npb24oc3RhcnRSaWdodElkLCB0aGVuLnJpZ2h0LCBjb21waWxlQ29udGV4dCk7XG4gICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIGxhc3RSaWdodElkLCBlbmRJZCk7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGlmICh0aGVuLm9wZXJhdG9yID09PSAnPT0nKSB7XG4gICAgICAgICAgICAgICAgY29uZGl0aW9uW3RoZW4ubGVmdC5uYW1lLnNwbGl0KCcuJywgMilbMV1dID0gY29tcGlsZUNvbnRleHQuYXN0TWFwW2xhc3RSaWdodElkXTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgY29uZGl0aW9uW3RoZW4ubGVmdC5uYW1lLnNwbGl0KCcuJywgMilbMV1dID0geyBbT1BFUkFUT1JfVE9LRU5bb3BdXTogY29tcGlsZUNvbnRleHQuYXN0TWFwW2xhc3RSaWdodElkXSB9O1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gSnNMYW5nLmFzdEFzc2lnbihhc3NpZ25UbywgSnNMYW5nLmFzdFZhbHVlKGNvbmRpdGlvbikpOyAgICAgICAgICAgXG4gICAgICAgIH1cblxuICAgICAgICBpZiAodGhlbi5vb2xUeXBlID09PSAnVW5hcnlFeHByZXNzaW9uJykge1xuICAgICAgICAgICAgXG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvL3RoZW4gZXhwcmVzc2lvbiBpcyBhbiBvb2xvbmcgY29uY3JldGUgdmFsdWUgICAgXG4gICAgaWYgKF8uaXNBcnJheSh0aGVuKSB8fCBfLmlzUGxhaW5PYmplY3QodGhlbikpIHtcbiAgICAgICAgbGV0IHZhbHVlRW5kSWQgPSBjb21waWxlQ29uY3JldGVWYWx1ZUV4cHJlc3Npb24oc3RhcnRJZCwgdGhlbiwgY29tcGlsZUNvbnRleHQpOyAgICBcbiAgICAgICAgdGhlbiA9IGNvbXBpbGVDb250ZXh0LmFzdE1hcFt2YWx1ZUVuZElkXTsgXG4gICAgfSAgIFxuXG4gICAgcmV0dXJuIEpzTGFuZy5hc3RBc3NpZ24oYXNzaWduVG8sIHRoZW4pO1xufVxuXG4vKipcbiAqIFRyYW5zbGF0ZSBhIHJldHVybiBjbGF1c2UgZnJvbSBvb2wgaW50byBhc3RcbiAqIEBwYXJhbSB7c3RyaW5nfSBzdGFydFRvcG9JZCAtIFRoZSB0b3BvIGlkIG9mIHRoZSBzdGFydGluZyBzdGF0ZSBvZiByZXR1cm4gY2xhdXNlXG4gKiBAcGFyYW0ge3N0cmluZ30gZW5kVG9wb0lkIC0gVGhlIHRvcG8gaWQgb2YgdGhlIGVuZGluZyBzdGF0ZSBvZiByZXR1cm4gY2xhdXNlXG4gKiBAcGFyYW0gdmFsdWVcbiAqIEBwYXJhbSBjb21waWxlQ29udGV4dFxuICogQHJldHVybnMge29iamVjdH0gQVNUIG9iamVjdFxuICovXG5mdW5jdGlvbiB0cmFuc2xhdGVSZXR1cm5WYWx1ZUFzdChzdGFydFRvcG9JZCwgZW5kVG9wb0lkLCB2YWx1ZSwgY29tcGlsZUNvbnRleHQpIHtcbiAgICBsZXQgdmFsdWVUb3BvSWQgPSBjb21waWxlQ29uY3JldGVWYWx1ZUV4cHJlc3Npb24oc3RhcnRUb3BvSWQsIHZhbHVlLCBjb21waWxlQ29udGV4dCk7XG4gICAgaWYgKHZhbHVlVG9wb0lkICE9PSBzdGFydFRvcG9JZCkge1xuICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIHZhbHVlVG9wb0lkLCBlbmRUb3BvSWQpO1xuICAgIH1cblxuICAgIHJldHVybiBKc0xhbmcuYXN0UmV0dXJuKGdldENvZGVSZXByZXNlbnRhdGlvbk9mKHZhbHVlVG9wb0lkLCBjb21waWxlQ29udGV4dCkpO1xufVxuXG4vKipcbiAqIENvbXBpbGUgYSByZXR1cm4gY2xhdXNlIGZyb20gb29sIGludG8gYXN0XG4gKiBAcGFyYW0ge3N0cmluZ30gc3RhcnRUb3BvSWQgLSBUaGUgdG9wbyBpZCBvZiB0aGUgc3RhcnRpbmcgcHJvY2VzcyB0byB0aGUgdGFyZ2V0IHZhbHVlIGV4cHJlc3Npb25cbiAqIEBwYXJhbSB2YWx1ZVxuICogQHBhcmFtIGNvbXBpbGVDb250ZXh0XG4gKiBAcmV0dXJucyB7b2JqZWN0fSBBU1Qgb2JqZWN0XG4gKi9cbmZ1bmN0aW9uIGNvbXBpbGVSZXR1cm4oc3RhcnRUb3BvSWQsIHZhbHVlLCBjb21waWxlQ29udGV4dCkge1xuICAgIGxldCBlbmRUb3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsICckcmV0dXJuJyk7XG4gICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCwgZW5kVG9wb0lkKTtcblxuICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtlbmRUb3BvSWRdID0gdHJhbnNsYXRlUmV0dXJuVmFsdWVBc3Qoc3RhcnRUb3BvSWQsIGVuZFRvcG9JZCwgdmFsdWUsIGNvbXBpbGVDb250ZXh0KTtcblxuICAgIGFkZENvZGVCbG9jayhjb21waWxlQ29udGV4dCwgZW5kVG9wb0lkLCB7XG4gICAgICAgIHR5cGU6IEFTVF9CTEtfVklFV19SRVRVUk5cbiAgICB9KTtcblxuICAgIHJldHVybiBlbmRUb3BvSWQ7XG59XG5cbi8qKlxuICogQ29tcGlsZSBhIGZpbmQgb25lIG9wZXJhdGlvbiBmcm9tIG9vbCBpbnRvIGFzdFxuICogQHBhcmFtIHtpbnR9IGluZGV4XG4gKiBAcGFyYW0ge29iamVjdH0gb3BlcmF0aW9uIC0gT29sIG5vZGVcbiAqIEBwYXJhbSB7b2JqZWN0fSBjb21waWxlQ29udGV4dCAtXG4gKiBAcGFyYW0ge3N0cmluZ30gZGVwZW5kZW5jeVxuICogQHJldHVybnMge3N0cmluZ30gbGFzdCB0b3BvSWRcbiAqL1xuZnVuY3Rpb24gY29tcGlsZUZpbmRPbmUoaW5kZXgsIG9wZXJhdGlvbiwgY29tcGlsZUNvbnRleHQsIGRlcGVuZGVuY3kpIHtcbiAgICBwcmU6IGRlcGVuZGVuY3k7XG5cbiAgICBsZXQgZW5kVG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCAnb3AkJyArIGluZGV4LnRvU3RyaW5nKCkpO1xuICAgIGxldCBjb25kaXRpb25WYXJOYW1lID0gZW5kVG9wb0lkICsgJyRjb25kaXRpb24nO1xuXG4gICAgbGV0IGFzdCA9IFtcbiAgICAgICAgSnNMYW5nLmFzdFZhckRlY2xhcmUoY29uZGl0aW9uVmFyTmFtZSlcbiAgICBdO1xuXG4gICAgYXNzZXJ0OiBvcGVyYXRpb24uY29uZGl0aW9uO1xuXG4gICAgY29tcGlsZUNvbnRleHQudmFyaWFibGVzW29wZXJhdGlvbi5tb2RlbF0gPSB7IHR5cGU6ICdlbnRpdHknLCBzb3VyY2U6ICdmaW5kT25lJywgb25nb2luZzogdHJ1ZSB9O1xuXG4gICAgaWYgKG9wZXJhdGlvbi5jb25kaXRpb24ub29sVHlwZSkge1xuICAgICAgICAvL3NwZWNpYWwgY29uZGl0aW9uXG5cbiAgICAgICAgaWYgKG9wZXJhdGlvbi5jb25kaXRpb24ub29sVHlwZSA9PT0gJ2Nhc2VzJykge1xuICAgICAgICAgICAgbGV0IHRvcG9JZFByZWZpeCA9IGVuZFRvcG9JZCArICckY2FzZXMnO1xuICAgICAgICAgICAgbGV0IGxhc3RTdGF0ZW1lbnQ7XG5cbiAgICAgICAgICAgIGlmIChvcGVyYXRpb24uY29uZGl0aW9uLmVsc2UpIHtcbiAgICAgICAgICAgICAgICBsZXQgZWxzZVN0YXJ0ID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCB0b3BvSWRQcmVmaXggKyAnOmVsc2UnKTtcbiAgICAgICAgICAgICAgICBsZXQgZWxzZUVuZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgdG9wb0lkUHJlZml4ICsgJzplbmQnKTtcbiAgICAgICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIGVsc2VTdGFydCwgZWxzZUVuZCk7XG4gICAgICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBlbHNlRW5kLCBlbmRUb3BvSWQpO1xuXG4gICAgICAgICAgICAgICAgbGFzdFN0YXRlbWVudCA9IHRyYW5zbGF0ZVRoZW5Bc3QoZWxzZVN0YXJ0LCBlbHNlRW5kLCBvcGVyYXRpb24uY29uZGl0aW9uLmVsc2UsIGNvbXBpbGVDb250ZXh0LCBjb25kaXRpb25WYXJOYW1lKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgbGFzdFN0YXRlbWVudCA9IEpzTGFuZy5hc3RUaHJvdygnU2VydmVyRXJyb3InLCAnVW5leHBlY3RlZCBzdGF0ZS4nKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKF8uaXNFbXB0eShvcGVyYXRpb24uY29uZGl0aW9uLml0ZW1zKSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignTWlzc2luZyBjYXNlIGl0ZW1zJyk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIF8ucmV2ZXJzZShvcGVyYXRpb24uY29uZGl0aW9uLml0ZW1zKS5mb3JFYWNoKChpdGVtLCBpKSA9PiB7XG4gICAgICAgICAgICAgICAgaWYgKGl0ZW0ub29sVHlwZSAhPT0gJ0NvbmRpdGlvbmFsU3RhdGVtZW50Jykge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ0ludmFsaWQgY2FzZSBpdGVtLicpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGkgPSBvcGVyYXRpb24uY29uZGl0aW9uLml0ZW1zLmxlbmd0aCAtIGkgLSAxO1xuXG4gICAgICAgICAgICAgICAgbGV0IGNhc2VQcmVmaXggPSB0b3BvSWRQcmVmaXggKyAnWycgKyBpLnRvU3RyaW5nKCkgKyAnXSc7XG4gICAgICAgICAgICAgICAgbGV0IGNhc2VUb3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIGNhc2VQcmVmaXgpO1xuICAgICAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgZGVwZW5kZW5jeSwgY2FzZVRvcG9JZCk7XG5cbiAgICAgICAgICAgICAgICBsZXQgY2FzZVJlc3VsdFZhck5hbWUgPSAnJCcgKyB0b3BvSWRQcmVmaXggKyAnXycgKyBpLnRvU3RyaW5nKCk7XG5cbiAgICAgICAgICAgICAgICBsZXQgbGFzdFRvcG9JZCA9IGNvbXBpbGVDb25kaXRpb25hbEV4cHJlc3Npb24oaXRlbS50ZXN0LCBjb21waWxlQ29udGV4dCwgY2FzZVRvcG9JZCk7XG4gICAgICAgICAgICAgICAgbGV0IGFzdENhc2VUdGVtID0gZ2V0Q29kZVJlcHJlc2VudGF0aW9uT2YobGFzdFRvcG9JZCwgY29tcGlsZUNvbnRleHQpO1xuXG4gICAgICAgICAgICAgICAgYXNzZXJ0OiAhQXJyYXkuaXNBcnJheShhc3RDYXNlVHRlbSksICdJbnZhbGlkIGNhc2UgaXRlbSBhc3QuJztcblxuICAgICAgICAgICAgICAgIGFzdENhc2VUdGVtID0gSnNMYW5nLmFzdFZhckRlY2xhcmUoY2FzZVJlc3VsdFZhck5hbWUsIGFzdENhc2VUdGVtLCB0cnVlLCBmYWxzZSwgYENvbmRpdGlvbiAke2l9IGZvciBmaW5kIG9uZSAke29wZXJhdGlvbi5tb2RlbH1gKTtcblxuICAgICAgICAgICAgICAgIGxldCBpZlN0YXJ0ID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBjYXNlUHJlZml4ICsgJzp0aGVuJyk7XG4gICAgICAgICAgICAgICAgbGV0IGlmRW5kID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBjYXNlUHJlZml4ICsgJzplbmQnKTtcbiAgICAgICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIGxhc3RUb3BvSWQsIGlmU3RhcnQpO1xuICAgICAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgaWZTdGFydCwgaWZFbmQpO1xuXG4gICAgICAgICAgICAgICAgbGFzdFN0YXRlbWVudCA9IFtcbiAgICAgICAgICAgICAgICAgICAgYXN0Q2FzZVR0ZW0sXG4gICAgICAgICAgICAgICAgICAgIEpzTGFuZy5hc3RJZihKc0xhbmcuYXN0VmFyUmVmKGNhc2VSZXN1bHRWYXJOYW1lKSwgSnNMYW5nLmFzdEJsb2NrKHRyYW5zbGF0ZVRoZW5Bc3QoaWZTdGFydCwgaWZFbmQsIGl0ZW0udGhlbiwgY29tcGlsZUNvbnRleHQsIGNvbmRpdGlvblZhck5hbWUpKSwgbGFzdFN0YXRlbWVudClcbiAgICAgICAgICAgICAgICBdO1xuICAgICAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgaWZFbmQsIGVuZFRvcG9JZCk7XG4gICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgYXN0ID0gYXN0LmNvbmNhdChfLmNhc3RBcnJheShsYXN0U3RhdGVtZW50KSk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ3RvZG8nKTtcbiAgICAgICAgfVxuXG5cbiAgICB9IGVsc2Uge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ3RvZG8nKTtcbiAgICB9XG5cbiAgICBhc3QucHVzaChcbiAgICAgICAgSnNMYW5nLmFzdFZhckRlY2xhcmUob3BlcmF0aW9uLm1vZGVsLCBKc0xhbmcuYXN0QXdhaXQoYHRoaXMuZmluZE9uZV9gLCBKc0xhbmcuYXN0VmFyUmVmKGNvbmRpdGlvblZhck5hbWUpKSlcbiAgICApO1xuXG4gICAgZGVsZXRlIGNvbXBpbGVDb250ZXh0LnZhcmlhYmxlc1tvcGVyYXRpb24ubW9kZWxdLm9uZ29pbmc7XG5cbiAgICBsZXQgbW9kZWxUb3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIG9wZXJhdGlvbi5tb2RlbCk7XG4gICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBlbmRUb3BvSWQsIG1vZGVsVG9wb0lkKTtcbiAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbZW5kVG9wb0lkXSA9IGFzdDtcbiAgICByZXR1cm4gZW5kVG9wb0lkO1xufVxuXG5mdW5jdGlvbiBjb21waWxlRGJPcGVyYXRpb24oaW5kZXgsIG9wZXJhdGlvbiwgY29tcGlsZUNvbnRleHQsIGRlcGVuZGVuY3kpIHtcbiAgICBsZXQgbGFzdFRvcG9JZDtcblxuICAgIHN3aXRjaCAob3BlcmF0aW9uLm9vbFR5cGUpIHtcbiAgICAgICAgY2FzZSAnRmluZE9uZVN0YXRlbWVudCc6XG4gICAgICAgICAgICBsYXN0VG9wb0lkID0gY29tcGlsZUZpbmRPbmUoaW5kZXgsIG9wZXJhdGlvbiwgY29tcGlsZUNvbnRleHQsIGRlcGVuZGVuY3kpO1xuICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgY2FzZSAnZmluZCc6XG4gICAgICAgICAgICAvL3ByZXBhcmVEYkNvbm5lY3Rpb24oY29tcGlsZUNvbnRleHQpO1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCd0YmknKTtcbiAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgIGNhc2UgJ3VwZGF0ZSc6XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ3RiaScpO1xuICAgICAgICAgICAgLy9wcmVwYXJlRGJDb25uZWN0aW9uKGNvbXBpbGVDb250ZXh0KTtcbiAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgIGNhc2UgJ2NyZWF0ZSc6XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ3RiaScpO1xuICAgICAgICAgICAgLy9wcmVwYXJlRGJDb25uZWN0aW9uKGNvbXBpbGVDb250ZXh0KTtcbiAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgIGNhc2UgJ2RlbGV0ZSc6XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ3RiaScpO1xuICAgICAgICAgICAgLy9wcmVwYXJlRGJDb25uZWN0aW9uKGNvbXBpbGVDb250ZXh0KTtcbiAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgIGNhc2UgJ0RvU3RhdGVtZW50JzpcbiAgICAgICAgICAgIGxldCBkb0Jsb2NrID0gb3BlcmF0aW9uLmRvO1xuICAgICAgICAgICAgbGFzdFRvcG9JZCA9IGNvbXBpbGVEb1N0YXRlbWVudChpbmRleCwgZG9CbG9jaywgY29tcGlsZUNvbnRleHQsIGRlcGVuZGVuY3kpO1xuICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgY2FzZSAnYXNzaWdubWVudCc6XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ3RiaScpO1xuICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5zdXBwb3J0ZWQgb3BlcmF0aW9uIHR5cGU6ICcgKyBvcGVyYXRpb24udHlwZSk7XG4gICAgfVxuXG4gICAgYWRkQ29kZUJsb2NrKGNvbXBpbGVDb250ZXh0LCBsYXN0VG9wb0lkLCB7XG4gICAgICAgIHR5cGU6IEFTVF9CTEtfSU5URVJGQUNFX09QRVJBVElPTlxuICAgIH0pO1xuXG4gICAgcmV0dXJuIGxhc3RUb3BvSWQ7XG59XG5cbmZ1bmN0aW9uIGNvbXBpbGVEb1N0YXRlbWVudChpbmRleCwgb3BlcmF0aW9uLCBjb21waWxlQ29udGV4dCwgZGVwZW5kZW5jeSkge1xuICAgICAgICBcbn1cblxuLyoqXG4gKiBDb21waWxlIGV4Y2VwdGlvbmFsIHJldHVybiBcbiAqIEBwYXJhbSB7b2JqZWN0fSBvb2xOb2RlXG4gKiBAcGFyYW0ge29iamVjdH0gY29tcGlsZUNvbnRleHRcbiAqIEBwYXJhbSB7c3RyaW5nfSBbZGVwZW5kZW5jeV1cbiAqIEByZXR1cm5zIHtzdHJpbmd9IGxhc3QgdG9wb0lkXG4gKi9cbmZ1bmN0aW9uIGNvbXBpbGVFeGNlcHRpb25hbFJldHVybihvb2xOb2RlLCBjb21waWxlQ29udGV4dCwgZGVwZW5kZW5jeSkge1xuICAgIHByZTogKF8uaXNQbGFpbk9iamVjdChvb2xOb2RlKSAmJiBvb2xOb2RlLm9vbFR5cGUgPT09ICdSZXR1cm5FeHByZXNzaW9uJyk7XG5cbiAgICBsZXQgZW5kVG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCAnJHJldHVybicpLCBsYXN0RXhjZXB0aW9uSWQgPSBkZXBlbmRlbmN5O1xuXG4gICAgaWYgKCFfLmlzRW1wdHkob29sTm9kZS5leGNlcHRpb25zKSkge1xuICAgICAgICBvb2xOb2RlLmV4Y2VwdGlvbnMuZm9yRWFjaCgoaXRlbSwgaSkgPT4ge1xuICAgICAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChpdGVtKSkge1xuICAgICAgICAgICAgICAgIGlmIChpdGVtLm9vbFR5cGUgIT09ICdDb25kaXRpb25hbFN0YXRlbWVudCcpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbnN1cHBvcnRlZCBleGNlcHRpb25hbCB0eXBlOiAnICsgaXRlbS5vb2xUeXBlKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBsZXQgZXhjZXB0aW9uU3RhcnRJZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgZW5kVG9wb0lkICsgJzpleGNlcHRbJyArIGkudG9TdHJpbmcoKSArICddJyk7XG4gICAgICAgICAgICAgICAgbGV0IGV4Y2VwdGlvbkVuZElkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBlbmRUb3BvSWQgKyAnOmV4Y2VwdFsnICsgaS50b1N0cmluZygpICsgJ106ZG9uZScpO1xuICAgICAgICAgICAgICAgIGlmIChsYXN0RXhjZXB0aW9uSWQpIHtcbiAgICAgICAgICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBsYXN0RXhjZXB0aW9uSWQsIGV4Y2VwdGlvblN0YXJ0SWQpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGxldCBsYXN0VG9wb0lkID0gY29tcGlsZUNvbmRpdGlvbmFsRXhwcmVzc2lvbihpdGVtLnRlc3QsIGNvbXBpbGVDb250ZXh0LCBleGNlcHRpb25TdGFydElkKTtcblxuICAgICAgICAgICAgICAgIGxldCB0aGVuU3RhcnRJZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgZXhjZXB0aW9uU3RhcnRJZCArICc6dGhlbicpO1xuICAgICAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgbGFzdFRvcG9JZCwgdGhlblN0YXJ0SWQpO1xuICAgICAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgdGhlblN0YXJ0SWQsIGV4Y2VwdGlvbkVuZElkKTtcblxuICAgICAgICAgICAgICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtleGNlcHRpb25FbmRJZF0gPSBKc0xhbmcuYXN0SWYoXG4gICAgICAgICAgICAgICAgICAgIGdldENvZGVSZXByZXNlbnRhdGlvbk9mKGxhc3RUb3BvSWQsIGNvbXBpbGVDb250ZXh0KSxcbiAgICAgICAgICAgICAgICAgICAgSnNMYW5nLmFzdEJsb2NrKHRyYW5zbGF0ZVJldHVyblRoZW5Bc3QoXG4gICAgICAgICAgICAgICAgICAgICAgICB0aGVuU3RhcnRJZCxcbiAgICAgICAgICAgICAgICAgICAgICAgIGV4Y2VwdGlvbkVuZElkLFxuICAgICAgICAgICAgICAgICAgICAgICAgaXRlbS50aGVuLCBjb21waWxlQ29udGV4dCkpLFxuICAgICAgICAgICAgICAgICAgICBudWxsLFxuICAgICAgICAgICAgICAgICAgICBgUmV0dXJuIG9uIGV4Y2VwdGlvbiAjJHtpfWBcbiAgICAgICAgICAgICAgICApO1xuXG4gICAgICAgICAgICAgICAgYWRkQ29kZUJsb2NrKGNvbXBpbGVDb250ZXh0LCBleGNlcHRpb25FbmRJZCwge1xuICAgICAgICAgICAgICAgICAgICB0eXBlOiBBU1RfQkxLX0VYQ0VQVElPTl9JVEVNXG4gICAgICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgICAgICBsYXN0RXhjZXB0aW9uSWQgPSBleGNlcHRpb25FbmRJZDtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbmV4cGVjdGVkLicpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIGxhc3RFeGNlcHRpb25JZCwgZW5kVG9wb0lkKTtcblxuICAgIGxldCByZXR1cm5TdGFydFRvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgJyRyZXR1cm46dmFsdWUnKTtcbiAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIHJldHVyblN0YXJ0VG9wb0lkLCBlbmRUb3BvSWQpO1xuXG4gICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW2VuZFRvcG9JZF0gPSB0cmFuc2xhdGVSZXR1cm5WYWx1ZUFzdChyZXR1cm5TdGFydFRvcG9JZCwgZW5kVG9wb0lkLCBvb2xOb2RlLnZhbHVlLCBjb21waWxlQ29udGV4dCk7XG5cbiAgICBhZGRDb2RlQmxvY2soY29tcGlsZUNvbnRleHQsIGVuZFRvcG9JZCwge1xuICAgICAgICB0eXBlOiBBU1RfQkxLX0lOVEVSRkFDRV9SRVRVUk5cbiAgICB9KTtcbiAgICBcbiAgICByZXR1cm4gZW5kVG9wb0lkO1xufVxuXG5mdW5jdGlvbiBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIG5hbWUpIHtcbiAgICBpZiAoY29tcGlsZUNvbnRleHQudG9wb05vZGVzLmhhcyhuYW1lKSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFRvcG8gaWQgXCIke25hbWV9XCIgYWxyZWFkeSBjcmVhdGVkLmApO1xuICAgIH1cblxuICAgIGFzc2VydDogIWNvbXBpbGVDb250ZXh0LnRvcG9Tb3J0Lmhhc0RlcGVuZGVuY3kobmFtZSksICdBbHJlYWR5IGluIHRvcG9Tb3J0ISc7XG5cbiAgICBjb21waWxlQ29udGV4dC50b3BvTm9kZXMuYWRkKG5hbWUpO1xuXG4gICAgcmV0dXJuIG5hbWU7XG59XG5cbmZ1bmN0aW9uIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgcHJldmlvdXNPcCwgY3VycmVudE9wKSB7XG4gICAgcHJlOiBwcmV2aW91c09wICE9PSBjdXJyZW50T3AsICdTZWxmIGRlcGVuZGluZyc7XG5cbiAgICBjb21waWxlQ29udGV4dC5sb2dnZXIuZGVidWcoY3VycmVudE9wICsgJyBcXHgxYlszM21kZXBlbmRzIG9uXFx4MWJbMG0gJyArIHByZXZpb3VzT3ApO1xuXG4gICAgaWYgKCFjb21waWxlQ29udGV4dC50b3BvTm9kZXMuaGFzKGN1cnJlbnRPcCkpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBUb3BvIGlkIFwiJHtjdXJyZW50T3B9XCIgbm90IGNyZWF0ZWQuYCk7XG4gICAgfVxuXG4gICAgY29tcGlsZUNvbnRleHQudG9wb1NvcnQuYWRkKHByZXZpb3VzT3AsIGN1cnJlbnRPcCk7XG59XG5cbmZ1bmN0aW9uIGFkZENvZGVCbG9jayhjb21waWxlQ29udGV4dCwgdG9wb0lkLCBibG9ja01ldGEpIHtcbiAgICBpZiAoISh0b3BvSWQgaW4gY29tcGlsZUNvbnRleHQuYXN0TWFwKSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEFTVCBub3QgZm91bmQgZm9yIGJsb2NrIHdpdGggdG9wb0lkOiAke3RvcG9JZH1gKTtcbiAgICB9XG5cbiAgICBjb21waWxlQ29udGV4dC5tYXBPZlRva2VuVG9NZXRhLnNldCh0b3BvSWQsIGJsb2NrTWV0YSk7XG5cbiAgICBjb21waWxlQ29udGV4dC5sb2dnZXIudmVyYm9zZShgQWRkaW5nICR7YmxvY2tNZXRhLnR5cGV9IFwiJHt0b3BvSWR9XCIgaW50byBzb3VyY2UgY29kZS5gKTtcbiAgICAvL2NvbXBpbGVDb250ZXh0LmxvZ2dlci5kZWJ1ZygnQVNUOlxcbicgKyBKU09OLnN0cmluZ2lmeShjb21waWxlQ29udGV4dC5hc3RNYXBbdG9wb0lkXSwgbnVsbCwgMikpO1xufVxuXG5mdW5jdGlvbiBnZXRDb2RlUmVwcmVzZW50YXRpb25PZih0b3BvSWQsIGNvbXBpbGVDb250ZXh0KSB7XG4gICAgbGV0IGxhc3RTb3VyY2VUeXBlID0gY29tcGlsZUNvbnRleHQubWFwT2ZUb2tlblRvTWV0YS5nZXQodG9wb0lkKTtcblxuICAgIGlmIChsYXN0U291cmNlVHlwZSAmJiAobGFzdFNvdXJjZVR5cGUudHlwZSA9PT0gQVNUX0JMS19QUk9DRVNTT1JfQ0FMTCB8fCBsYXN0U291cmNlVHlwZS50eXBlID09PSBBU1RfQkxLX0FDVElWQVRPUl9DQUxMKSkge1xuICAgICAgICAvL2ZvciBtb2RpZmllciwganVzdCB1c2UgdGhlIGZpbmFsIHJlc3VsdFxuICAgICAgICByZXR1cm4gSnNMYW5nLmFzdFZhclJlZihsYXN0U291cmNlVHlwZS50YXJnZXQsIHRydWUpO1xuICAgIH1cblxuICAgIGxldCBhc3QgPSBjb21waWxlQ29udGV4dC5hc3RNYXBbdG9wb0lkXTtcbiAgICBpZiAoYXN0LnR5cGUgPT09ICdNZW1iZXJFeHByZXNzaW9uJyAmJiBhc3Qub2JqZWN0Lm5hbWUgPT09ICdsYXRlc3QnKSB7XG4gICAgICAgIHJldHVybiBKc0xhbmcuYXN0Q29uZGl0aW9uYWwoXG4gICAgICAgICAgICBKc0xhbmcuYXN0Q2FsbCgnbGF0ZXN0Lmhhc093blByb3BlcnR5JywgWyBhc3QucHJvcGVydHkudmFsdWUgXSksIC8qKiB0ZXN0ICovXG4gICAgICAgICAgICBhc3QsIC8qKiBjb25zZXF1ZW50ICovXG4gICAgICAgICAgICB7IC4uLmFzdCwgb2JqZWN0OiB7IC4uLmFzdC5vYmplY3QsIG5hbWU6ICdleGlzdGluZycgfSB9XG4gICAgICAgICk7ICAgXG4gICAgfVxuXG4gICAgcmV0dXJuIGNvbXBpbGVDb250ZXh0LmFzdE1hcFt0b3BvSWRdO1xufVxuXG5mdW5jdGlvbiBjcmVhdGVDb21waWxlQ29udGV4dChtb2R1bGVOYW1lLCBsb2dnZXIsIHNoYXJlZENvbnRleHQpIHtcbiAgICBsZXQgY29tcGlsZUNvbnRleHQgPSB7XG4gICAgICAgIG1vZHVsZU5hbWUsICAgICAgICBcbiAgICAgICAgbG9nZ2VyLFxuICAgICAgICB2YXJpYWJsZXM6IHt9LFxuICAgICAgICB0b3BvTm9kZXM6IG5ldyBTZXQoKSxcbiAgICAgICAgdG9wb1NvcnQ6IG5ldyBUb3BvU29ydCgpLFxuICAgICAgICBhc3RNYXA6IHt9LCAvLyBTdG9yZSB0aGUgQVNUIGZvciBhIG5vZGVcbiAgICAgICAgbWFwT2ZUb2tlblRvTWV0YTogbmV3IE1hcCgpLCAvLyBTdG9yZSB0aGUgc291cmNlIGNvZGUgYmxvY2sgcG9pbnRcbiAgICAgICAgbW9kZWxWYXJzOiBuZXcgU2V0KCksXG4gICAgICAgIG1hcE9mRnVuY3RvclRvRmlsZTogKHNoYXJlZENvbnRleHQgJiYgc2hhcmVkQ29udGV4dC5tYXBPZkZ1bmN0b3JUb0ZpbGUpIHx8IHt9LCAvLyBVc2UgdG8gcmVjb3JkIGltcG9ydCBsaW5lc1xuICAgICAgICBuZXdGdW5jdG9yRmlsZXM6IChzaGFyZWRDb250ZXh0ICYmIHNoYXJlZENvbnRleHQubmV3RnVuY3RvckZpbGVzKSB8fCBbXVxuICAgIH07XG5cbiAgICBjb21waWxlQ29udGV4dC5tYWluU3RhcnRJZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgJyRtYWluJyk7XG5cbiAgICBsb2dnZXIudmVyYm9zZShgQ3JlYXRlZCBjb21waWxhdGlvbiBjb250ZXh0IGZvciBcIiR7bW9kdWxlTmFtZX1cIi5gKTtcblxuICAgIHJldHVybiBjb21waWxlQ29udGV4dDtcbn1cblxuZnVuY3Rpb24gaXNUb3BMZXZlbEJsb2NrKHRvcG9JZCkge1xuICAgIHJldHVybiB0b3BvSWQuaW5kZXhPZignOmFyZ1snKSA9PT0gLTEgJiYgdG9wb0lkLmluZGV4T2YoJyRjYXNlc1snKSA9PT0gLTEgJiYgdG9wb0lkLmluZGV4T2YoJyRleGNlcHRpb25zWycpID09PSAtMTtcbn1cblxuZnVuY3Rpb24gcmVwbGFjZVZhclJlZlNjb3BlKHZhclJlZiwgdGFyZ2V0U2NvcGUpIHtcbiAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHZhclJlZikpIHtcbiAgICAgICAgYXNzZXJ0OiB2YXJSZWYub29sVHlwZSA9PT0gJ09iamVjdFJlZmVyZW5jZSc7XG5cbiAgICAgICAgcmV0dXJuIHsgb29sVHlwZTogJ09iamVjdFJlZmVyZW5jZScsIG5hbWU6IHJlcGxhY2VWYXJSZWZTY29wZSh2YXJSZWYubmFtZSwgdGFyZ2V0U2NvcGUpIH07ICAgICAgICBcbiAgICB9IFxuXG4gICAgYXNzZXJ0OiB0eXBlb2YgdmFyUmVmID09PSAnc3RyaW5nJztcblxuICAgIGxldCBwYXJ0cyA9IHZhclJlZi5zcGxpdCgnLicpO1xuICAgIGFzc2VydDogcGFydHMubGVuZ3RoID4gMTtcblxuICAgIHBhcnRzLnNwbGljZSgwLCAxLCB0YXJnZXRTY29wZSk7XG4gICAgcmV0dXJuIHBhcnRzLmpvaW4oJy4nKTtcbn1cblxubW9kdWxlLmV4cG9ydHMgPSB7XG4gICAgY29tcGlsZVBhcmFtLFxuICAgIGNvbXBpbGVGaWVsZCxcbiAgICBjb21waWxlRGJPcGVyYXRpb24sXG4gICAgY29tcGlsZUV4Y2VwdGlvbmFsUmV0dXJuLFxuICAgIGNvbXBpbGVSZXR1cm4sXG4gICAgY3JlYXRlVG9wb0lkLFxuICAgIGNyZWF0ZUNvbXBpbGVDb250ZXh0LFxuICAgIGRlcGVuZHNPbixcbiAgICBhZGRDb2RlQmxvY2ssXG5cbiAgICBBU1RfQkxLX0ZJRUxEX1BSRV9QUk9DRVNTLFxuICAgIEFTVF9CTEtfUFJPQ0VTU09SX0NBTEwsXG4gICAgQVNUX0JMS19WQUxJREFUT1JfQ0FMTCxcbiAgICBBU1RfQkxLX0FDVElWQVRPUl9DQUxMLFxuICAgIEFTVF9CTEtfVklFV19PUEVSQVRJT04sXG4gICAgQVNUX0JMS19WSUVXX1JFVFVSTixcbiAgICBBU1RfQkxLX0lOVEVSRkFDRV9PUEVSQVRJT04sXG4gICAgQVNUX0JMS19JTlRFUkZBQ0VfUkVUVVJOLCBcbiAgICBBU1RfQkxLX0VYQ0VQVElPTl9JVEVNLFxuXG4gICAgT09MX01PRElGSUVSX0NPREVfRkxBR1xufTsiXX0=