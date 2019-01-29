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
    compileContext.astMap[topoId] = JsLang.astCall(functorId, callArgs);
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
    case 'findOne':
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

    case 'javascript':
      throw new Error('tbi');
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9tb2RlbGVyL3V0aWwvb29sVG9Bc3QuanMiXSwibmFtZXMiOlsiXyIsInJlcXVpcmUiLCJUb3BvU29ydCIsIkpzTGFuZyIsIk9vbFR5cGVzIiwiaXNEb3RTZXBhcmF0ZU5hbWUiLCJleHRyYWN0RG90U2VwYXJhdGVOYW1lIiwiZXh0cmFjdFJlZmVyZW5jZUJhc2VOYW1lIiwiT29sb25nVmFsaWRhdG9ycyIsIk9vbG9uZ1Byb2Nlc3NvcnMiLCJPb2xvbmdBY3RpdmF0b3JzIiwiVHlwZXMiLCJkZWZhdWx0RXJyb3IiLCJBU1RfQkxLX0ZJRUxEX1BSRV9QUk9DRVNTIiwiQVNUX0JMS19QQVJBTV9TQU5JVElaRSIsIkFTVF9CTEtfUFJPQ0VTU09SX0NBTEwiLCJBU1RfQkxLX1ZBTElEQVRPUl9DQUxMIiwiQVNUX0JMS19BQ1RJVkFUT1JfQ0FMTCIsIkFTVF9CTEtfVklFV19PUEVSQVRJT04iLCJBU1RfQkxLX1ZJRVdfUkVUVVJOIiwiQVNUX0JMS19JTlRFUkZBQ0VfT1BFUkFUSU9OIiwiQVNUX0JMS19JTlRFUkZBQ0VfUkVUVVJOIiwiQVNUX0JMS19FWENFUFRJT05fSVRFTSIsIk9PTF9NT0RJRklFUl9DT0RFX0ZMQUciLCJNb2RpZmllciIsIlZBTElEQVRPUiIsIlBST0NFU1NPUiIsIkFDVElWQVRPUiIsIk9PTF9NT0RJRklFUl9PUCIsIk9PTF9NT0RJRklFUl9QQVRIIiwiT09MX01PRElGSUVSX0JVSUxUSU4iLCJPUEVSQVRPUl9UT0tFTiIsImNvbXBpbGVDb25kaXRpb25hbEV4cHJlc3Npb24iLCJ0ZXN0IiwiY29tcGlsZUNvbnRleHQiLCJzdGFydFRvcG9JZCIsImlzUGxhaW5PYmplY3QiLCJvb2xUeXBlIiwiZW5kVG9wb0lkIiwiY3JlYXRlVG9wb0lkIiwib3BlcmFuZFRvcG9JZCIsImRlcGVuZHNPbiIsImxhc3RPcGVyYW5kVG9wb0lkIiwiY29tcGlsZUNvbmNyZXRlVmFsdWVFeHByZXNzaW9uIiwiY2FsbGVyIiwiYXN0QXJndW1lbnQiLCJnZXRDb2RlUmVwcmVzZW50YXRpb25PZiIsInJldFRvcG9JZCIsImNvbXBpbGVBZEhvY1ZhbGlkYXRvciIsImNhbGxlZSIsIm9wIiwib3BlcmF0b3IiLCJFcnJvciIsImxlZnRUb3BvSWQiLCJyaWdodFRvcG9JZCIsImxhc3RMZWZ0SWQiLCJsZWZ0IiwibGFzdFJpZ2h0SWQiLCJyaWdodCIsImFzdE1hcCIsImFzdEJpbkV4cCIsImFyZ3VtZW50IiwiYXN0Tm90IiwiYXN0Q2FsbCIsInZhbHVlU3RhcnRUb3BvSWQiLCJhc3RWYWx1ZSIsInRvcG9JZCIsInZhbHVlIiwiZnVuY3RvciIsImNhbGxBcmdzIiwiYXJncyIsInRyYW5zbGF0ZUFyZ3MiLCJhcmcwIiwibmFtZSIsImNvbmNhdCIsImNvbXBpbGVNb2RpZmllciIsImRlY2xhcmVQYXJhbXMiLCJ0cmFuc2xhdGVGdW5jdGlvblBhcmFtcyIsImlzRW1wdHkiLCJmdW5jdG9ySWQiLCJ0cmFuc2xhdGVNb2RpZmllciIsInJlZmVyZW5jZXMiLCJleHRyYWN0UmVmZXJlbmNlZEZpZWxkcyIsImZpbmQiLCJyZWYiLCJpc1RvcExldmVsQmxvY2siLCJzdGFydHNXaXRoIiwiYXN0Q29uZGl0aW9uYWwiLCJyZXBsYWNlVmFyUmVmU2NvcGUiLCJ0YXJnZXRWYXJOYW1lIiwibmVlZERlY2xhcmUiLCJ2YXJpYWJsZXMiLCJjb3VudGVyIiwidG9TdHJpbmciLCJoYXNPd25Qcm9wZXJ0eSIsInR5cGUiLCJzb3VyY2UiLCJhZGRDb2RlQmxvY2siLCJ0YXJnZXQiLCJvb2xBcmdzIiwiY2FzdEFycmF5IiwicmVmcyIsImZvckVhY2giLCJhIiwicmVzdWx0IiwiY2hlY2tSZWZlcmVuY2VUb0ZpZWxkIiwicHVzaCIsIm9iaiIsInVuZGVmaW5lZCIsImFkZE1vZGlmaWVyVG9NYXAiLCJmdW5jdG9yVHlwZSIsImZ1bmN0b3JKc0ZpbGUiLCJtYXBPZkZ1bmN0b3JUb0ZpbGUiLCJmdW5jdGlvbk5hbWUiLCJmaWxlTmFtZSIsIm5hbWVzIiwibGVuZ3RoIiwicmVmRW50aXR5TmFtZSIsInVwcGVyRmlyc3QiLCJidWlsdGlucyIsIm1vZHVsZU5hbWUiLCJuZXdGdW5jdG9yRmlsZXMiLCJjb21waWxlUGlwZWRWYWx1ZSIsInZhck9vbCIsImxhc3RUb3BvSWQiLCJtb2RpZmllcnMiLCJtb2RpZmllciIsIm1vZGlmaWVyU3RhcnRUb3BvSWQiLCJjb21waWxlVmFyaWFibGVSZWZlcmVuY2UiLCJTZXQiLCJ0cmFuc2xhdGVGdW5jdGlvblBhcmFtIiwiYXJnIiwiaSIsInBvcCIsIm1hcCIsImJhc2VOYW1lIiwiY291bnQiLCJoYXMiLCJhZGQiLCJyZWZCYXNlIiwicmVzdCIsImRlcGVuZGVuY3kiLCJvbmdvaW5nIiwicmVmRmllbGROYW1lIiwibWFwVmFsdWVzIiwidmFsdWVPZkVsZW1lbnQiLCJrZXkiLCJzaWQiLCJlaWQiLCJBcnJheSIsImlzQXJyYXkiLCJpbmRleCIsImVhY2giLCJhcmdUb3BvSWQiLCJjb21waWxlUGFyYW0iLCJwYXJhbSIsInR5cGVPYmplY3QiLCJzYW5pdGl6ZXJOYW1lIiwidG9VcHBlckNhc2UiLCJ2YXJSZWYiLCJhc3RWYXJSZWYiLCJjYWxsQXN0IiwiYXN0QXJyYXlBY2Nlc3MiLCJwcmVwYXJlVG9wb0lkIiwiYXN0QXNzaWduIiwibWFpblN0YXJ0SWQiLCJ3cmFwUGFyYW1SZWZlcmVuY2UiLCJyZWFkeVRvcG9JZCIsImNvbXBpbGVGaWVsZCIsInBhcmFtTmFtZSIsImNvbnRleHROYW1lIiwiT2JqZWN0IiwiYXNzaWduIiwiaGFzTW9kZWxGaWVsZCIsIm9wZXJhbmQiLCJiYXNlVmFyIiwic3BsaXQiLCJ0cmFuc2xhdGVSZXR1cm5UaGVuQXN0Iiwic3RhcnRJZCIsImVuZElkIiwidGhlbiIsImFzdFRocm93IiwiZXJyb3JUeXBlIiwibWVzc2FnZSIsInRyYW5zbGF0ZVJldHVyblZhbHVlQXN0IiwidmFsdWVFbmRJZCIsImFzdFJldHVybiIsInRyYW5zbGF0ZVRoZW5Bc3QiLCJhc3NpZ25UbyIsImNvbmRpdGlvbiIsInN0YXJ0UmlnaHRJZCIsInZhbHVlVG9wb0lkIiwiY29tcGlsZVJldHVybiIsImNvbXBpbGVGaW5kT25lIiwib3BlcmF0aW9uIiwiY29uZGl0aW9uVmFyTmFtZSIsImFzdCIsImFzdFZhckRlY2xhcmUiLCJtb2RlbCIsInRvcG9JZFByZWZpeCIsImxhc3RTdGF0ZW1lbnQiLCJlbHNlIiwiZWxzZVN0YXJ0IiwiZWxzZUVuZCIsIml0ZW1zIiwicmV2ZXJzZSIsIml0ZW0iLCJjYXNlUHJlZml4IiwiY2FzZVRvcG9JZCIsImNhc2VSZXN1bHRWYXJOYW1lIiwiYXN0Q2FzZVR0ZW0iLCJpZlN0YXJ0IiwiaWZFbmQiLCJhc3RJZiIsImFzdEJsb2NrIiwiYXN0QXdhaXQiLCJtb2RlbFRvcG9JZCIsImNvbXBpbGVEYk9wZXJhdGlvbiIsImNvbXBpbGVFeGNlcHRpb25hbFJldHVybiIsIm9vbE5vZGUiLCJsYXN0RXhjZXB0aW9uSWQiLCJleGNlcHRpb25zIiwiZXhjZXB0aW9uU3RhcnRJZCIsImV4Y2VwdGlvbkVuZElkIiwidGhlblN0YXJ0SWQiLCJyZXR1cm5TdGFydFRvcG9JZCIsInRvcG9Ob2RlcyIsInRvcG9Tb3J0IiwiaGFzRGVwZW5kZW5jeSIsInByZXZpb3VzT3AiLCJjdXJyZW50T3AiLCJsb2dnZXIiLCJkZWJ1ZyIsImJsb2NrTWV0YSIsIm1hcE9mVG9rZW5Ub01ldGEiLCJzZXQiLCJ2ZXJib3NlIiwibGFzdFNvdXJjZVR5cGUiLCJnZXQiLCJvYmplY3QiLCJwcm9wZXJ0eSIsImNyZWF0ZUNvbXBpbGVDb250ZXh0Iiwic2hhcmVkQ29udGV4dCIsIk1hcCIsIm1vZGVsVmFycyIsImluZGV4T2YiLCJ0YXJnZXRTY29wZSIsInBhcnRzIiwic3BsaWNlIiwiam9pbiIsIm1vZHVsZSIsImV4cG9ydHMiXSwibWFwcGluZ3MiOiJBQUFBOzs7O0FBT0EsTUFBTTtBQUFFQSxFQUFBQTtBQUFGLElBQVFDLE9BQU8sQ0FBQyxVQUFELENBQXJCOztBQUNBLE1BQU07QUFBRUMsRUFBQUE7QUFBRixJQUFlRCxPQUFPLENBQUMscUJBQUQsQ0FBNUI7O0FBRUEsTUFB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QkYsV0FBbkI7QUFDQSxTQUFPQyxLQUFLLENBQUNFLElBQU4sQ0FBVyxHQUFYLENBQVA7QUFDSDs7QUFFREMsTUFBTSxDQUFDQyxPQUFQLEdBQWlCO0FBQ2JqRyxFQUFBQSxZQURhO0FBRWJjLEVBQUFBLFlBRmE7QUFHYmlELEVBQUFBLGtCQUhhO0FBSWJDLEVBQUFBLHdCQUphO0FBS2IxQixFQUFBQSxhQUxhO0FBTWJ6SixFQUFBQSxZQU5hO0FBT2IwTSxFQUFBQSxvQkFQYTtBQVFieE0sRUFBQUEsU0FSYTtBQVNid0QsRUFBQUEsWUFUYTtBQVdicEYsRUFBQUEseUJBWGE7QUFZYkUsRUFBQUEsc0JBWmE7QUFhYkMsRUFBQUEsc0JBYmE7QUFjYkMsRUFBQUEsc0JBZGE7QUFlYkMsRUFBQUEsc0JBZmE7QUFnQmJDLEVBQUFBLG1CQWhCYTtBQWlCYkMsRUFBQUEsMkJBakJhO0FBa0JiQyxFQUFBQSx3QkFsQmE7QUFtQmJDLEVBQUFBLHNCQW5CYTtBQXFCYkMsRUFBQUE7QUFyQmEsQ0FBakIiLCJzb3VyY2VzQ29udGVudCI6WyJcInVzZSBzdHJpY3RcIjtcblxuLyoqXG4gKiBAbW9kdWxlXG4gKiBAaWdub3JlXG4gKi9cblxuY29uc3QgeyBfIH0gPSByZXF1aXJlKCdyay11dGlscycpO1xuY29uc3QgeyBUb3BvU29ydCB9ID0gcmVxdWlyZSgnQGstc3VpdGUvYWxnb3JpdGhtcycpO1xuXG5jb25zdCBKc0xhbmcgPSByZXF1aXJlKCcuL2FzdC5qcycpO1xuY29uc3QgT29sVHlwZXMgPSByZXF1aXJlKCcuLi8uLi9sYW5nL09vbFR5cGVzJyk7XG5jb25zdCB7IGlzRG90U2VwYXJhdGVOYW1lLCBleHRyYWN0RG90U2VwYXJhdGVOYW1lLCBleHRyYWN0UmVmZXJlbmNlQmFzZU5hbWUgfSA9IHJlcXVpcmUoJy4uLy4uL2xhbmcvT29sVXRpbHMnKTtcbmNvbnN0IE9vbG9uZ1ZhbGlkYXRvcnMgPSByZXF1aXJlKCcuLi8uLi9ydW50aW1lL1ZhbGlkYXRvcnMnKTtcbmNvbnN0IE9vbG9uZ1Byb2Nlc3NvcnMgPSByZXF1aXJlKCcuLi8uLi9ydW50aW1lL1Byb2Nlc3NvcnMnKTtcbmNvbnN0IE9vbG9uZ0FjdGl2YXRvcnMgPSByZXF1aXJlKCcuLi8uLi9ydW50aW1lL0FjdGl2YXRvcnMnKTtcbmNvbnN0IFR5cGVzID0gcmVxdWlyZSgnLi4vLi4vcnVudGltZS90eXBlcycpO1xuXG5jb25zdCBkZWZhdWx0RXJyb3IgPSAnSW52YWxpZFJlcXVlc3QnO1xuXG5jb25zdCBBU1RfQkxLX0ZJRUxEX1BSRV9QUk9DRVNTID0gJ0ZpZWxkUHJlUHJvY2Vzcyc7XG5jb25zdCBBU1RfQkxLX1BBUkFNX1NBTklUSVpFID0gJ1BhcmFtZXRlclNhbml0aXplJztcbmNvbnN0IEFTVF9CTEtfUFJPQ0VTU09SX0NBTEwgPSAnUHJvY2Vzc29yQ2FsbCc7XG5jb25zdCBBU1RfQkxLX1ZBTElEQVRPUl9DQUxMID0gJ1ZhbGlkYXRvckNhbGwnO1xuY29uc3QgQVNUX0JMS19BQ1RJVkFUT1JfQ0FMTCA9ICdBY3RpdmF0b3JDYWxsJztcbmNvbnN0IEFTVF9CTEtfVklFV19PUEVSQVRJT04gPSAnVmlld09wZXJhdGlvbic7XG5jb25zdCBBU1RfQkxLX1ZJRVdfUkVUVVJOID0gJ1ZpZXdSZXR1cm4nO1xuY29uc3QgQVNUX0JMS19JTlRFUkZBQ0VfT1BFUkFUSU9OID0gJ0ludGVyZmFjZU9wZXJhdGlvbic7XG5jb25zdCBBU1RfQkxLX0lOVEVSRkFDRV9SRVRVUk4gPSAnSW50ZXJmYWNlUmV0dXJuJztcbmNvbnN0IEFTVF9CTEtfRVhDRVBUSU9OX0lURU0gPSAnRXhjZXB0aW9uSXRlbSc7XG5cbmNvbnN0IE9PTF9NT0RJRklFUl9DT0RFX0ZMQUcgPSB7XG4gICAgW09vbFR5cGVzLk1vZGlmaWVyLlZBTElEQVRPUl06IEFTVF9CTEtfVkFMSURBVE9SX0NBTEwsXG4gICAgW09vbFR5cGVzLk1vZGlmaWVyLlBST0NFU1NPUl06IEFTVF9CTEtfUFJPQ0VTU09SX0NBTEwsXG4gICAgW09vbFR5cGVzLk1vZGlmaWVyLkFDVElWQVRPUl06IEFTVF9CTEtfQUNUSVZBVE9SX0NBTExcbn07XG5cbmNvbnN0IE9PTF9NT0RJRklFUl9PUCA9IHtcbiAgICBbT29sVHlwZXMuTW9kaWZpZXIuVkFMSURBVE9SXTogJ34nLFxuICAgIFtPb2xUeXBlcy5Nb2RpZmllci5QUk9DRVNTT1JdOiAnfD4nLFxuICAgIFtPb2xUeXBlcy5Nb2RpZmllci5BQ1RJVkFUT1JdOiAnPScgXG59O1xuXG5jb25zdCBPT0xfTU9ESUZJRVJfUEFUSCA9IHtcbiAgICBbT29sVHlwZXMuTW9kaWZpZXIuVkFMSURBVE9SXTogJ3ZhbGlkYXRvcnMnLFxuICAgIFtPb2xUeXBlcy5Nb2RpZmllci5QUk9DRVNTT1JdOiAncHJvY2Vzc29ycycsXG4gICAgW09vbFR5cGVzLk1vZGlmaWVyLkFDVElWQVRPUl06ICdhY3RpdmF0b3JzJyBcbn07XG5cbmNvbnN0IE9PTF9NT0RJRklFUl9CVUlMVElOID0ge1xuICAgIFtPb2xUeXBlcy5Nb2RpZmllci5WQUxJREFUT1JdOiBPb2xvbmdWYWxpZGF0b3JzLFxuICAgIFtPb2xUeXBlcy5Nb2RpZmllci5QUk9DRVNTT1JdOiBPb2xvbmdQcm9jZXNzb3JzLFxuICAgIFtPb2xUeXBlcy5Nb2RpZmllci5BQ1RJVkFUT1JdOiBPb2xvbmdBY3RpdmF0b3JzIFxufTtcblxuY29uc3QgT1BFUkFUT1JfVE9LRU4gPSB7XG4gICAgXCI+XCI6IFwiJGd0XCIsXG4gICAgXCI8XCI6IFwiJGx0XCIsXG4gICAgXCI+PVwiOiBcIiRndGVcIixcbiAgICBcIjw9XCI6IFwiJGx0ZVwiLFxuICAgIFwiPT1cIjogXCIkZXFcIixcbiAgICBcIiE9XCI6IFwiJG5lXCIsXG4gICAgXCJpblwiOiBcIiRpblwiLFxuICAgIFwibm90SW5cIjogXCIkbmluXCJcbn07XG5cbi8qKlxuICogQ29tcGlsZSBhIGNvbmRpdGlvbmFsIGV4cHJlc3Npb25cbiAqIEBwYXJhbSB7b2JqZWN0fSB0ZXN0XG4gKiBAcGFyYW0ge29iamVjdH0gY29tcGlsZUNvbnRleHRcbiAqIEBwcm9wZXJ0eSB7c3RyaW5nfSBjb21waWxlQ29udGV4dC5tb2R1bGVOYW1lXG4gKiBAcHJvcGVydHkge1RvcG9Tb3J0fSBjb21waWxlQ29udGV4dC50b3BvU29ydFxuICogQHByb3BlcnR5IHtvYmplY3R9IGNvbXBpbGVDb250ZXh0LmFzdE1hcCAtIFRvcG8gSWQgdG8gYXN0IG1hcFxuICogQHBhcmFtIHtzdHJpbmd9IHN0YXJ0VG9wb0lkXG4gKiBAcmV0dXJucyB7c3RyaW5nfSBUb3BvIElkXG4gKi9cbmZ1bmN0aW9uIGNvbXBpbGVDb25kaXRpb25hbEV4cHJlc3Npb24odGVzdCwgY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkKSB7XG4gICAgaWYgKF8uaXNQbGFpbk9iamVjdCh0ZXN0KSkgeyAgICAgICAgXG4gICAgICAgIGlmICh0ZXN0Lm9vbFR5cGUgPT09ICdWYWxpZGF0ZUV4cHJlc3Npb24nKSB7XG4gICAgICAgICAgICBsZXQgZW5kVG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCArICckdmFsaU9wOmRvbmUnKTtcbiAgICAgICAgICAgIGxldCBvcGVyYW5kVG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCArICckdmFsaU9wJyk7XG5cbiAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgc3RhcnRUb3BvSWQsIG9wZXJhbmRUb3BvSWQpO1xuXG4gICAgICAgICAgICBsZXQgbGFzdE9wZXJhbmRUb3BvSWQgPSBjb21waWxlQ29uY3JldGVWYWx1ZUV4cHJlc3Npb24ob3BlcmFuZFRvcG9JZCwgdGVzdC5jYWxsZXIsIGNvbXBpbGVDb250ZXh0KTtcbiAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgbGFzdE9wZXJhbmRUb3BvSWQsIGVuZFRvcG9JZCk7XG5cbiAgICAgICAgICAgIGxldCBhc3RBcmd1bWVudCA9IGdldENvZGVSZXByZXNlbnRhdGlvbk9mKGxhc3RPcGVyYW5kVG9wb0lkLCBjb21waWxlQ29udGV4dCk7XG5cbiAgICAgICAgICAgIGxldCByZXRUb3BvSWQgPSBjb21waWxlQWRIb2NWYWxpZGF0b3IoZW5kVG9wb0lkLCBhc3RBcmd1bWVudCwgdGVzdC5jYWxsZWUsIGNvbXBpbGVDb250ZXh0KTtcblxuICAgICAgICAgICAgYXNzZXJ0OiByZXRUb3BvSWQgPT09IGVuZFRvcG9JZDtcblxuICAgICAgICAgICAgLypcbiAgICAgICAgICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtlbmRUb3BvSWRdID0gSnNMYW5nLmFzdENhbGwoJ18uaXNFbXB0eScsIGFzdEFyZ3VtZW50KTtcblxuICAgICAgICAgICAgc3dpdGNoICh0ZXN0Lm9wZXJhdG9yKSB7XG4gICAgICAgICAgICAgICAgY2FzZSAnZXhpc3RzJzpcbiAgICAgICAgICAgICAgICAgICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW2VuZFRvcG9JZF0gPSBKc0xhbmcuYXN0Tm90KEpzTGFuZy5hc3RDYWxsKCdfLmlzRW1wdHknLCBhc3RBcmd1bWVudCkpO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgICAgIGNhc2UgJ2lzLW5vdC1udWxsJzpcbiAgICAgICAgICAgICAgICAgICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW2VuZFRvcG9JZF0gPSBKc0xhbmcuYXN0Tm90KEpzTGFuZy5hc3RDYWxsKCdfLmlzTmlsJywgYXN0QXJndW1lbnQpKTtcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgICAgICBjYXNlICdub3QtZXhpc3RzJzpcbiAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgY2FzZSAnaXMtbnVsbCc6XG4gICAgICAgICAgICAgICAgICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtlbmRUb3BvSWRdID0gSnNMYW5nLmFzdENhbGwoJ18uaXNOaWwnLCBhc3RBcmd1bWVudCk7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgY2FzZSAnbm90JzpcbiAgICAgICAgICAgICAgICAgICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW2VuZFRvcG9JZF0gPSBKc0xhbmcuYXN0Tm90KGFzdEFyZ3VtZW50KTtcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1Vuc3VwcG9ydGVkIHRlc3Qgb3BlcmF0b3I6ICcgKyB0ZXN0Lm9wZXJhdG9yKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgICovXG5cbiAgICAgICAgICAgIHJldHVybiBlbmRUb3BvSWQ7XG5cbiAgICAgICAgfSBlbHNlIGlmICh0ZXN0Lm9vbFR5cGUgPT09ICdMb2dpY2FsRXhwcmVzc2lvbicpIHtcbiAgICAgICAgICAgIGxldCBlbmRUb3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkICsgJyRsb3BPcDpkb25lJyk7XG5cbiAgICAgICAgICAgIGxldCBvcDtcblxuICAgICAgICAgICAgc3dpdGNoICh0ZXN0Lm9wZXJhdG9yKSB7XG4gICAgICAgICAgICAgICAgY2FzZSAnYW5kJzpcbiAgICAgICAgICAgICAgICAgICAgb3AgPSAnJiYnO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgICAgIGNhc2UgJ29yJzpcbiAgICAgICAgICAgICAgICAgICAgb3AgPSAnfHwnO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5zdXBwb3J0ZWQgdGVzdCBvcGVyYXRvcjogJyArIHRlc3Qub3BlcmF0b3IpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgbGVmdFRvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgc3RhcnRUb3BvSWQgKyAnJGxvcE9wOmxlZnQnKTtcbiAgICAgICAgICAgIGxldCByaWdodFRvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgc3RhcnRUb3BvSWQgKyAnJGxvcE9wOnJpZ2h0Jyk7XG5cbiAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgc3RhcnRUb3BvSWQsIGxlZnRUb3BvSWQpO1xuICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCwgcmlnaHRUb3BvSWQpO1xuXG4gICAgICAgICAgICBsZXQgbGFzdExlZnRJZCA9IGNvbXBpbGVDb25kaXRpb25hbEV4cHJlc3Npb24odGVzdC5sZWZ0LCBjb21waWxlQ29udGV4dCwgbGVmdFRvcG9JZCk7XG4gICAgICAgICAgICBsZXQgbGFzdFJpZ2h0SWQgPSBjb21waWxlQ29uZGl0aW9uYWxFeHByZXNzaW9uKHRlc3QucmlnaHQsIGNvbXBpbGVDb250ZXh0LCByaWdodFRvcG9JZCk7XG5cbiAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgbGFzdExlZnRJZCwgZW5kVG9wb0lkKTtcbiAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgbGFzdFJpZ2h0SWQsIGVuZFRvcG9JZCk7XG5cbiAgICAgICAgICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtlbmRUb3BvSWRdID0gSnNMYW5nLmFzdEJpbkV4cChcbiAgICAgICAgICAgICAgICBnZXRDb2RlUmVwcmVzZW50YXRpb25PZihsYXN0TGVmdElkLCBjb21waWxlQ29udGV4dCksXG4gICAgICAgICAgICAgICAgb3AsXG4gICAgICAgICAgICAgICAgZ2V0Q29kZVJlcHJlc2VudGF0aW9uT2YobGFzdFJpZ2h0SWQsIGNvbXBpbGVDb250ZXh0KVxuICAgICAgICAgICAgKTsgXG5cbiAgICAgICAgICAgIHJldHVybiBlbmRUb3BvSWQ7XG5cbiAgICAgICAgfSBlbHNlIGlmICh0ZXN0Lm9vbFR5cGUgPT09ICdCaW5hcnlFeHByZXNzaW9uJykge1xuICAgICAgICAgICAgbGV0IGVuZFRvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgc3RhcnRUb3BvSWQgKyAnJGJpbk9wOmRvbmUnKTtcblxuICAgICAgICAgICAgbGV0IG9wO1xuXG4gICAgICAgICAgICBzd2l0Y2ggKHRlc3Qub3BlcmF0b3IpIHtcbiAgICAgICAgICAgICAgICBjYXNlICc+JzpcbiAgICAgICAgICAgICAgICBjYXNlICc8JzpcbiAgICAgICAgICAgICAgICBjYXNlICc+PSc6XG4gICAgICAgICAgICAgICAgY2FzZSAnPD0nOlxuICAgICAgICAgICAgICAgIGNhc2UgJ2luJzpcbiAgICAgICAgICAgICAgICAgICAgb3AgPSB0ZXN0Lm9wZXJhdG9yO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgICAgIGNhc2UgJz09JzpcbiAgICAgICAgICAgICAgICAgICAgb3AgPSAnPT09JztcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgICAgICBjYXNlICchPSc6XG4gICAgICAgICAgICAgICAgICAgIG9wID0gJyE9PSc7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbnN1cHBvcnRlZCB0ZXN0IG9wZXJhdG9yOiAnICsgdGVzdC5vcGVyYXRvcik7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCBsZWZ0VG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCArICckYmluT3A6bGVmdCcpO1xuICAgICAgICAgICAgbGV0IHJpZ2h0VG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCArICckYmluT3A6cmlnaHQnKTtcblxuICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCwgbGVmdFRvcG9JZCk7XG4gICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkLCByaWdodFRvcG9JZCk7XG5cbiAgICAgICAgICAgIGxldCBsYXN0TGVmdElkID0gY29tcGlsZUNvbmNyZXRlVmFsdWVFeHByZXNzaW9uKGxlZnRUb3BvSWQsIHRlc3QubGVmdCwgY29tcGlsZUNvbnRleHQpO1xuICAgICAgICAgICAgbGV0IGxhc3RSaWdodElkID0gY29tcGlsZUNvbmNyZXRlVmFsdWVFeHByZXNzaW9uKHJpZ2h0VG9wb0lkLCB0ZXN0LnJpZ2h0LCBjb21waWxlQ29udGV4dCk7XG5cbiAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgbGFzdExlZnRJZCwgZW5kVG9wb0lkKTtcbiAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgbGFzdFJpZ2h0SWQsIGVuZFRvcG9JZCk7XG5cbiAgICAgICAgICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtlbmRUb3BvSWRdID0gSnNMYW5nLmFzdEJpbkV4cChcbiAgICAgICAgICAgICAgICBnZXRDb2RlUmVwcmVzZW50YXRpb25PZihsYXN0TGVmdElkLCBjb21waWxlQ29udGV4dCksXG4gICAgICAgICAgICAgICAgb3AsXG4gICAgICAgICAgICAgICAgZ2V0Q29kZVJlcHJlc2VudGF0aW9uT2YobGFzdFJpZ2h0SWQsIGNvbXBpbGVDb250ZXh0KVxuICAgICAgICAgICAgKTsgXG5cbiAgICAgICAgICAgIHJldHVybiBlbmRUb3BvSWQ7XG5cbiAgICAgICAgfSBlbHNlIGlmICh0ZXN0Lm9vbFR5cGUgPT09ICdVbmFyeUV4cHJlc3Npb24nKSB7XG4gICAgICAgICAgICBsZXQgZW5kVG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCArICckdW5hT3A6ZG9uZScpO1xuICAgICAgICAgICAgbGV0IG9wZXJhbmRUb3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkICsgJyR1bmFPcCcpO1xuXG4gICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkLCBvcGVyYW5kVG9wb0lkKTtcblxuICAgICAgICAgICAgbGV0IGxhc3RPcGVyYW5kVG9wb0lkID0gdGVzdC5vcGVyYXRvciA9PT0gJ25vdCcgPyBjb21waWxlQ29uY3JldGVWYWx1ZUV4cHJlc3Npb24ob3BlcmFuZFRvcG9JZCwgdGVzdC5hcmd1bWVudCwgY29tcGlsZUNvbnRleHQpIDogY29tcGlsZUNvbmRpdGlvbmFsRXhwcmVzc2lvbih0ZXN0LmFyZ3VtZW50LCBjb21waWxlQ29udGV4dCwgb3BlcmFuZFRvcG9JZCk7XG4gICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIGxhc3RPcGVyYW5kVG9wb0lkLCBlbmRUb3BvSWQpO1xuXG4gICAgICAgICAgICBsZXQgYXN0QXJndW1lbnQgPSBnZXRDb2RlUmVwcmVzZW50YXRpb25PZihsYXN0T3BlcmFuZFRvcG9JZCwgY29tcGlsZUNvbnRleHQpO1xuXG4gICAgICAgICAgICBzd2l0Y2ggKHRlc3Qub3BlcmF0b3IpIHtcbiAgICAgICAgICAgICAgICBjYXNlICdleGlzdHMnOlxuICAgICAgICAgICAgICAgICAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbZW5kVG9wb0lkXSA9IEpzTGFuZy5hc3ROb3QoSnNMYW5nLmFzdENhbGwoJ18uaXNFbXB0eScsIGFzdEFyZ3VtZW50KSk7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgY2FzZSAnaXMtbm90LW51bGwnOlxuICAgICAgICAgICAgICAgICAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbZW5kVG9wb0lkXSA9IEpzTGFuZy5hc3ROb3QoSnNMYW5nLmFzdENhbGwoJ18uaXNOaWwnLCBhc3RBcmd1bWVudCkpO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgICAgIGNhc2UgJ25vdC1leGlzdHMnOlxuICAgICAgICAgICAgICAgICAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbZW5kVG9wb0lkXSA9IEpzTGFuZy5hc3RDYWxsKCdfLmlzRW1wdHknLCBhc3RBcmd1bWVudCk7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgY2FzZSAnaXMtbnVsbCc6XG4gICAgICAgICAgICAgICAgICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtlbmRUb3BvSWRdID0gSnNMYW5nLmFzdENhbGwoJ18uaXNOaWwnLCBhc3RBcmd1bWVudCk7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgY2FzZSAnbm90JzpcbiAgICAgICAgICAgICAgICAgICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW2VuZFRvcG9JZF0gPSBKc0xhbmcuYXN0Tm90KGFzdEFyZ3VtZW50KTtcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1Vuc3VwcG9ydGVkIHRlc3Qgb3BlcmF0b3I6ICcgKyB0ZXN0Lm9wZXJhdG9yKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIGVuZFRvcG9JZDtcblxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgbGV0IHZhbHVlU3RhcnRUb3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkICsgJyR2YWx1ZScpO1xuICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCwgdmFsdWVTdGFydFRvcG9JZCk7XG4gICAgICAgICAgICByZXR1cm4gY29tcGlsZUNvbmNyZXRlVmFsdWVFeHByZXNzaW9uKHZhbHVlU3RhcnRUb3BvSWQsIHRlc3QsIGNvbXBpbGVDb250ZXh0KTtcbiAgICAgICAgfSBcbiAgICB9XG5cbiAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbc3RhcnRUb3BvSWRdID0gSnNMYW5nLmFzdFZhbHVlKHRlc3QpO1xuICAgIHJldHVybiBzdGFydFRvcG9JZDtcbn1cblxuLyoqXG4gKiBDb21waWxlIGEgdmFsaWRhdG9yIGNhbGxlZCBpbiBhIGxvZ2ljYWwgZXhwcmVzc2lvbi5cbiAqIEBwYXJhbSB2YWx1ZVxuICogQHBhcmFtIGZ1bmN0b3JzXG4gKiBAcGFyYW0gY29tcGlsZUNvbnRleHRcbiAqIEBwYXJhbSB0b3BvSW5mb1xuICogQHByb3BlcnR5IHtzdHJpbmd9IHRvcG9JbmZvLnRvcG9JZFByZWZpeFxuICogQHByb3BlcnR5IHtzdHJpbmd9IHRvcG9JbmZvLmxhc3RUb3BvSWRcbiAqIEByZXR1cm5zIHsqfHN0cmluZ31cbiAqL1xuZnVuY3Rpb24gY29tcGlsZUFkSG9jVmFsaWRhdG9yKHRvcG9JZCwgdmFsdWUsIGZ1bmN0b3IsIGNvbXBpbGVDb250ZXh0KSB7XG4gICAgYXNzZXJ0OiBmdW5jdG9yLm9vbFR5cGUgPT09IE9vbFR5cGVzLk1vZGlmaWVyLlZBTElEQVRPUjsgICAgICAgIFxuXG4gICAgbGV0IGNhbGxBcmdzO1xuICAgIFxuICAgIGlmIChmdW5jdG9yLmFyZ3MpIHtcbiAgICAgICAgY2FsbEFyZ3MgPSB0cmFuc2xhdGVBcmdzKHRvcG9JZCwgZnVuY3Rvci5hcmdzLCBjb21waWxlQ29udGV4dCk7ICAgICAgICBcbiAgICB9IGVsc2Uge1xuICAgICAgICBjYWxsQXJncyA9IFtdO1xuICAgIH0gICAgICAgICAgICBcbiAgICBcbiAgICBsZXQgYXJnMCA9IHZhbHVlO1xuICAgIFxuICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFt0b3BvSWRdID0gSnNMYW5nLmFzdENhbGwoJ1ZhbGlkYXRvcnMuJyArIGZ1bmN0b3IubmFtZSwgWyBhcmcwIF0uY29uY2F0KGNhbGxBcmdzKSk7XG5cbiAgICByZXR1cm4gdG9wb0lkO1xufVxuXG4vKipcbiAqIENvbXBpbGUgYSBtb2RpZmllciBmcm9tIG9vbCB0byBhc3QuXG4gKiBAcGFyYW0gdG9wb0lkIC0gc3RhcnRUb3BvSWRcbiAqIEBwYXJhbSB2YWx1ZVxuICogQHBhcmFtIGZ1bmN0b3JzXG4gKiBAcGFyYW0gY29tcGlsZUNvbnRleHRcbiAqIEBwYXJhbSB0b3BvSW5mb1xuICogQHByb3BlcnR5IHtzdHJpbmd9IHRvcG9JbmZvLnRvcG9JZFByZWZpeFxuICogQHByb3BlcnR5IHtzdHJpbmd9IHRvcG9JbmZvLmxhc3RUb3BvSWRcbiAqIEByZXR1cm5zIHsqfHN0cmluZ31cbiAqL1xuZnVuY3Rpb24gY29tcGlsZU1vZGlmaWVyKHRvcG9JZCwgdmFsdWUsIGZ1bmN0b3IsIGNvbXBpbGVDb250ZXh0KSB7XG4gICAgbGV0IGRlY2xhcmVQYXJhbXM7XG5cbiAgICBpZiAoZnVuY3Rvci5vb2xUeXBlID09PSBPb2xUeXBlcy5Nb2RpZmllci5BQ1RJVkFUT1IpIHsgXG4gICAgICAgIGRlY2xhcmVQYXJhbXMgPSB0cmFuc2xhdGVGdW5jdGlvblBhcmFtcyhmdW5jdG9yLmFyZ3MpOyAgICAgICAgXG4gICAgfSBlbHNlIHtcbiAgICAgICAgZGVjbGFyZVBhcmFtcyA9IHRyYW5zbGF0ZUZ1bmN0aW9uUGFyYW1zKF8uaXNFbXB0eShmdW5jdG9yLmFyZ3MpID8gW3ZhbHVlXSA6IFt2YWx1ZV0uY29uY2F0KGZ1bmN0b3IuYXJncykpOyAgICAgICAgXG4gICAgfSAgICAgICAgXG5cbiAgICBsZXQgZnVuY3RvcklkID0gdHJhbnNsYXRlTW9kaWZpZXIoZnVuY3RvciwgY29tcGlsZUNvbnRleHQsIGRlY2xhcmVQYXJhbXMpO1xuXG4gICAgbGV0IGNhbGxBcmdzLCByZWZlcmVuY2VzO1xuICAgIFxuICAgIGlmIChmdW5jdG9yLmFyZ3MpIHtcbiAgICAgICAgY2FsbEFyZ3MgPSB0cmFuc2xhdGVBcmdzKHRvcG9JZCwgZnVuY3Rvci5hcmdzLCBjb21waWxlQ29udGV4dCk7XG4gICAgICAgIHJlZmVyZW5jZXMgPSBleHRyYWN0UmVmZXJlbmNlZEZpZWxkcyhmdW5jdG9yLmFyZ3MpO1xuXG4gICAgICAgIGlmIChfLmZpbmQocmVmZXJlbmNlcywgcmVmID0+IHJlZiA9PT0gdmFsdWUubmFtZSkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignQ2Fubm90IHVzZSB0aGUgdGFyZ2V0IGZpZWxkIGl0c2VsZiBhcyBhbiBhcmd1bWVudCBvZiBhIG1vZGlmaWVyLicpO1xuICAgICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgICAgY2FsbEFyZ3MgPSBbXTtcbiAgICB9ICAgICAgICBcbiAgICBcbiAgICBpZiAoZnVuY3Rvci5vb2xUeXBlID09PSBPb2xUeXBlcy5Nb2RpZmllci5BQ1RJVkFUT1IpIHsgICAgICAgICAgICBcbiAgICAgICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW3RvcG9JZF0gPSBKc0xhbmcuYXN0Q2FsbChmdW5jdG9ySWQsIGNhbGxBcmdzKTtcbiAgICB9IGVsc2Uge1xuICAgICAgICBsZXQgYXJnMCA9IHZhbHVlO1xuICAgICAgICBpZiAoIWlzVG9wTGV2ZWxCbG9jayh0b3BvSWQpICYmIF8uaXNQbGFpbk9iamVjdCh2YWx1ZSkgJiYgdmFsdWUub29sVHlwZSA9PT0gJ09iamVjdFJlZmVyZW5jZScgJiYgdmFsdWUubmFtZS5zdGFydHNXaXRoKCdsYXRlc3QuJykpIHtcbiAgICAgICAgICAgIC8vbGV0IGV4aXN0aW5nUmVmID0gICAgICAgICAgICBcbiAgICAgICAgICAgIGFyZzAgPSBKc0xhbmcuYXN0Q29uZGl0aW9uYWwoXG4gICAgICAgICAgICAgICAgSnNMYW5nLmFzdENhbGwoJ2xhdGVzdC5oYXNPd25Qcm9wZXJ0eScsIFsgZXh0cmFjdFJlZmVyZW5jZUJhc2VOYW1lKHZhbHVlLm5hbWUpIF0pLCAvKiogdGVzdCAqL1xuICAgICAgICAgICAgICAgIHZhbHVlLCAvKiogY29uc2VxdWVudCAqL1xuICAgICAgICAgICAgICAgIHJlcGxhY2VWYXJSZWZTY29wZSh2YWx1ZSwgJ2V4aXN0aW5nJylcbiAgICAgICAgICAgICk7ICBcbiAgICAgICAgfVxuICAgICAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbdG9wb0lkXSA9IEpzTGFuZy5hc3RDYWxsKGZ1bmN0b3JJZCwgWyBhcmcwIF0uY29uY2F0KGNhbGxBcmdzKSk7XG4gICAgfSAgICBcblxuICAgIGlmIChpc1RvcExldmVsQmxvY2sodG9wb0lkKSkge1xuICAgICAgICBsZXQgdGFyZ2V0VmFyTmFtZSA9IHZhbHVlLm5hbWU7XG4gICAgICAgIGxldCBuZWVkRGVjbGFyZSA9IGZhbHNlO1xuXG4gICAgICAgIGlmICghaXNEb3RTZXBhcmF0ZU5hbWUodmFsdWUubmFtZSkgJiYgY29tcGlsZUNvbnRleHQudmFyaWFibGVzW3ZhbHVlLm5hbWVdICYmIGZ1bmN0b3Iub29sVHlwZSAhPT0gT29sVHlwZXMuTW9kaWZpZXIuVkFMSURBVE9SKSB7XG4gICAgICAgICAgICAvL2NvbmZsaWN0IHdpdGggZXhpc3RpbmcgdmFyaWFibGVzLCBuZWVkIHRvIHJlbmFtZSB0byBhbm90aGVyIHZhcmlhYmxlXG4gICAgICAgICAgICBsZXQgY291bnRlciA9IDE7XG4gICAgICAgICAgICBkbyB7XG4gICAgICAgICAgICAgICAgY291bnRlcisrOyAgICAgICBcbiAgICAgICAgICAgICAgICB0YXJnZXRWYXJOYW1lID0gdmFsdWUubmFtZSArIGNvdW50ZXIudG9TdHJpbmcoKTsgICAgICAgICBcbiAgICAgICAgICAgIH0gd2hpbGUgKGNvbXBpbGVDb250ZXh0LnZhcmlhYmxlcy5oYXNPd25Qcm9wZXJ0eSh0YXJnZXRWYXJOYW1lKSk7ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGNvbXBpbGVDb250ZXh0LnZhcmlhYmxlc1t0YXJnZXRWYXJOYW1lXSA9IHsgdHlwZTogJ2xvY2FsVmFyaWFibGUnLCBzb3VyY2U6ICdtb2RpZmllcicgfTtcbiAgICAgICAgICAgIG5lZWREZWNsYXJlID0gdHJ1ZTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vaWYgKGNvbXBpbGVDb250ZXh0LnZhcmlhYmxlc1tdKVxuXG4gICAgICAgIGFkZENvZGVCbG9jayhjb21waWxlQ29udGV4dCwgdG9wb0lkLCB7XG4gICAgICAgICAgICB0eXBlOiBPT0xfTU9ESUZJRVJfQ09ERV9GTEFHW2Z1bmN0b3Iub29sVHlwZV0sXG4gICAgICAgICAgICB0YXJnZXQ6IHRhcmdldFZhck5hbWUsXG4gICAgICAgICAgICByZWZlcmVuY2VzLCAgIC8vIGxhdGVzdC4sIGV4c2l0aW5nLiwgcmF3LlxuICAgICAgICAgICAgbmVlZERlY2xhcmVcbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgcmV0dXJuIHRvcG9JZDtcbn0gIFxuICAgICAgXG5mdW5jdGlvbiBleHRyYWN0UmVmZXJlbmNlZEZpZWxkcyhvb2xBcmdzKSB7ICAgXG4gICAgb29sQXJncyA9IF8uY2FzdEFycmF5KG9vbEFyZ3MpOyAgICBcblxuICAgIGxldCByZWZzID0gW107XG5cbiAgICBvb2xBcmdzLmZvckVhY2goYSA9PiB7XG4gICAgICAgIGxldCByZXN1bHQgPSBjaGVja1JlZmVyZW5jZVRvRmllbGQoYSk7XG4gICAgICAgIGlmIChyZXN1bHQpIHtcbiAgICAgICAgICAgIHJlZnMucHVzaChyZXN1bHQpO1xuICAgICAgICB9XG4gICAgfSk7XG5cbiAgICByZXR1cm4gcmVmcztcbn1cblxuZnVuY3Rpb24gY2hlY2tSZWZlcmVuY2VUb0ZpZWxkKG9iaikge1xuICAgIGlmIChfLmlzUGxhaW5PYmplY3Qob2JqKSAmJiBvYmoub29sVHlwZSkge1xuICAgICAgICBpZiAob2JqLm9vbFR5cGUgPT09ICdQaXBlZFZhbHVlJykgcmV0dXJuIGNoZWNrUmVmZXJlbmNlVG9GaWVsZChvYmoudmFsdWUpO1xuICAgICAgICBpZiAob2JqLm9vbFR5cGUgPT09ICdPYmplY3RSZWZlcmVuY2UnKSB7XG4gICAgICAgICAgICByZXR1cm4gb2JqLm5hbWU7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICByZXR1cm4gdW5kZWZpbmVkO1xufVxuXG5mdW5jdGlvbiBhZGRNb2RpZmllclRvTWFwKGZ1bmN0b3JJZCwgZnVuY3RvclR5cGUsIGZ1bmN0b3JKc0ZpbGUsIG1hcE9mRnVuY3RvclRvRmlsZSkge1xuICAgIGlmIChtYXBPZkZ1bmN0b3JUb0ZpbGVbZnVuY3RvcklkXSAmJiBtYXBPZkZ1bmN0b3JUb0ZpbGVbZnVuY3RvcklkXSAhPT0gZnVuY3RvckpzRmlsZSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYENvbmZsaWN0OiAke2Z1bmN0b3JUeXBlfSBuYW1pbmcgXCIke2Z1bmN0b3JJZH1cIiBjb25mbGljdHMhYCk7XG4gICAgfVxuICAgIG1hcE9mRnVuY3RvclRvRmlsZVtmdW5jdG9ySWRdID0gZnVuY3RvckpzRmlsZTtcbn1cblxuLyoqXG4gKiBDaGVjayB3aGV0aGVyIGEgZnVuY3RvciBpcyB1c2VyLWRlZmluZWQgb3IgYnVpbHQtaW5cbiAqIEBwYXJhbSBmdW5jdG9yXG4gKiBAcGFyYW0gY29tcGlsZUNvbnRleHRcbiAqIEBwYXJhbSBhcmdzIC0gVXNlZCB0byBtYWtlIHVwIHRoZSBmdW5jdGlvbiBzaWduYXR1cmVcbiAqIEByZXR1cm5zIHtzdHJpbmd9IGZ1bmN0b3IgaWRcbiAqL1xuZnVuY3Rpb24gdHJhbnNsYXRlTW9kaWZpZXIoZnVuY3RvciwgY29tcGlsZUNvbnRleHQsIGFyZ3MpIHtcbiAgICBsZXQgZnVuY3Rpb25OYW1lLCBmaWxlTmFtZSwgZnVuY3RvcklkO1xuXG4gICAgLy9leHRyYWN0IHZhbGlkYXRvciBuYW1pbmcgYW5kIGltcG9ydCBpbmZvcm1hdGlvblxuICAgIGlmIChpc0RvdFNlcGFyYXRlTmFtZShmdW5jdG9yLm5hbWUpKSB7XG4gICAgICAgIGxldCBuYW1lcyA9IGV4dHJhY3REb3RTZXBhcmF0ZU5hbWUoZnVuY3Rvci5uYW1lKTtcbiAgICAgICAgaWYgKG5hbWVzLmxlbmd0aCA+IDIpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignTm90IHN1cHBvcnRlZCByZWZlcmVuY2UgdHlwZTogJyArIGZ1bmN0b3IubmFtZSk7XG4gICAgICAgIH1cblxuICAgICAgICAvL3JlZmVyZW5jZSB0byBvdGhlciBlbnRpdHkgZmlsZVxuICAgICAgICBsZXQgcmVmRW50aXR5TmFtZSA9IG5hbWVzWzBdO1xuICAgICAgICBmdW5jdGlvbk5hbWUgPSBuYW1lc1sxXTtcbiAgICAgICAgZmlsZU5hbWUgPSAnLi8nICsgT09MX01PRElGSUVSX1BBVEhbZnVuY3Rvci5vb2xUeXBlXSArICcvJyArIHJlZkVudGl0eU5hbWUgKyAnLScgKyBmdW5jdGlvbk5hbWUgKyAnLmpzJztcbiAgICAgICAgZnVuY3RvcklkID0gcmVmRW50aXR5TmFtZSArIF8udXBwZXJGaXJzdChmdW5jdGlvbk5hbWUpO1xuICAgICAgICBhZGRNb2RpZmllclRvTWFwKGZ1bmN0b3JJZCwgZnVuY3Rvci5vb2xUeXBlLCBmaWxlTmFtZSwgY29tcGlsZUNvbnRleHQubWFwT2ZGdW5jdG9yVG9GaWxlKTtcblxuICAgIH0gZWxzZSB7XG4gICAgICAgIGZ1bmN0aW9uTmFtZSA9IGZ1bmN0b3IubmFtZTtcblxuICAgICAgICBsZXQgYnVpbHRpbnMgPSBPT0xfTU9ESUZJRVJfQlVJTFRJTltmdW5jdG9yLm9vbFR5cGVdO1xuXG4gICAgICAgIGlmICghKGZ1bmN0aW9uTmFtZSBpbiBidWlsdGlucykpIHtcbiAgICAgICAgICAgIGZpbGVOYW1lID0gJy4vJyArIE9PTF9NT0RJRklFUl9QQVRIW2Z1bmN0b3Iub29sVHlwZV0gKyAnLycgKyBjb21waWxlQ29udGV4dC5tb2R1bGVOYW1lICsgJy0nICsgZnVuY3Rpb25OYW1lICsgJy5qcyc7XG4gICAgICAgICAgICBmdW5jdG9ySWQgPSBmdW5jdGlvbk5hbWU7XG5cbiAgICAgICAgICAgIGlmICghY29tcGlsZUNvbnRleHQubWFwT2ZGdW5jdG9yVG9GaWxlW2Z1bmN0b3JJZF0pIHtcbiAgICAgICAgICAgICAgICBjb21waWxlQ29udGV4dC5uZXdGdW5jdG9yRmlsZXMucHVzaCh7XG4gICAgICAgICAgICAgICAgICAgIGZ1bmN0aW9uTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgZnVuY3RvclR5cGU6IGZ1bmN0b3Iub29sVHlwZSxcbiAgICAgICAgICAgICAgICAgICAgZmlsZU5hbWUsXG4gICAgICAgICAgICAgICAgICAgIGFyZ3NcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYWRkTW9kaWZpZXJUb01hcChmdW5jdG9ySWQsIGZ1bmN0b3Iub29sVHlwZSwgZmlsZU5hbWUsIGNvbXBpbGVDb250ZXh0Lm1hcE9mRnVuY3RvclRvRmlsZSk7ICAgICAgICAgICAgXG4gICAgICAgIH0gZWxzZSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBmdW5jdG9ySWQgPSBmdW5jdG9yLm9vbFR5cGUgKyAncy4nICsgZnVuY3Rpb25OYW1lO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgcmV0dXJuIGZ1bmN0b3JJZDtcbn1cblxuLyoqXG4gKiBDb21waWxlIGEgcGlwZWQgdmFsdWUgZnJvbSBvb2wgdG8gYXN0LlxuICogQHBhcmFtIHtzdHJpbmd9IHN0YXJ0VG9wb0lkIC0gVGhlIHRvcG9sb2dpY2FsIGlkIG9mIHRoZSBzdGFydGluZyBwcm9jZXNzIHRvIHRoZSB0YXJnZXQgdmFsdWUsIGRlZmF1bHQgYXMgdGhlIHBhcmFtIG5hbWVcbiAqIEBwYXJhbSB7b2JqZWN0fSB2YXJPb2wgLSBUYXJnZXQgdmFsdWUgb29sIG5vZGUuXG4gKiBAcGFyYW0ge29iamVjdH0gY29tcGlsZUNvbnRleHQgLSBDb21waWxhdGlvbiBjb250ZXh0LlxuICogQHByb3BlcnR5IHtzdHJpbmd9IGNvbXBpbGVDb250ZXh0Lm1vZHVsZU5hbWVcbiAqIEBwcm9wZXJ0eSB7VG9wb1NvcnR9IGNvbXBpbGVDb250ZXh0LnRvcG9Tb3J0XG4gKiBAcHJvcGVydHkge29iamVjdH0gY29tcGlsZUNvbnRleHQuYXN0TWFwIC0gVG9wbyBJZCB0byBhc3QgbWFwXG4gKiBAcmV0dXJucyB7c3RyaW5nfSBMYXN0IHRvcG8gSWRcbiAqL1xuZnVuY3Rpb24gY29tcGlsZVBpcGVkVmFsdWUoc3RhcnRUb3BvSWQsIHZhck9vbCwgY29tcGlsZUNvbnRleHQpIHtcbiAgICBsZXQgbGFzdFRvcG9JZCA9IGNvbXBpbGVDb25jcmV0ZVZhbHVlRXhwcmVzc2lvbihzdGFydFRvcG9JZCwgdmFyT29sLnZhbHVlLCBjb21waWxlQ29udGV4dCk7XG5cbiAgICB2YXJPb2wubW9kaWZpZXJzLmZvckVhY2gobW9kaWZpZXIgPT4ge1xuICAgICAgICBsZXQgbW9kaWZpZXJTdGFydFRvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgc3RhcnRUb3BvSWQgKyBPT0xfTU9ESUZJRVJfT1BbbW9kaWZpZXIub29sVHlwZV0gKyBtb2RpZmllci5uYW1lKTtcbiAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBsYXN0VG9wb0lkLCBtb2RpZmllclN0YXJ0VG9wb0lkKTtcblxuICAgICAgICBsYXN0VG9wb0lkID0gY29tcGlsZU1vZGlmaWVyKFxuICAgICAgICAgICAgbW9kaWZpZXJTdGFydFRvcG9JZCxcbiAgICAgICAgICAgIHZhck9vbC52YWx1ZSxcbiAgICAgICAgICAgIG1vZGlmaWVyLFxuICAgICAgICAgICAgY29tcGlsZUNvbnRleHRcbiAgICAgICAgKTtcbiAgICB9KTtcblxuICAgIHJldHVybiBsYXN0VG9wb0lkO1xufVxuXG4vKipcbiAqIENvbXBpbGUgYSB2YXJpYWJsZSByZWZlcmVuY2UgZnJvbSBvb2wgdG8gYXN0LlxuICogQHBhcmFtIHtzdHJpbmd9IHN0YXJ0VG9wb0lkIC0gVGhlIHRvcG9sb2dpY2FsIGlkIG9mIHRoZSBzdGFydGluZyBwcm9jZXNzIHRvIHRoZSB0YXJnZXQgdmFsdWUsIGRlZmF1bHQgYXMgdGhlIHBhcmFtIG5hbWVcbiAqIEBwYXJhbSB7b2JqZWN0fSB2YXJPb2wgLSBUYXJnZXQgdmFsdWUgb29sIG5vZGUuXG4gKiBAcGFyYW0ge29iamVjdH0gY29tcGlsZUNvbnRleHQgLSBDb21waWxhdGlvbiBjb250ZXh0LlxuICogQHByb3BlcnR5IHtzdHJpbmd9IGNvbXBpbGVDb250ZXh0Lm1vZHVsZU5hbWVcbiAqIEBwcm9wZXJ0eSB7VG9wb1NvcnR9IGNvbXBpbGVDb250ZXh0LnRvcG9Tb3J0XG4gKiBAcHJvcGVydHkge29iamVjdH0gY29tcGlsZUNvbnRleHQuYXN0TWFwIC0gVG9wbyBJZCB0byBhc3QgbWFwXG4gKiBAcmV0dXJucyB7c3RyaW5nfSBMYXN0IHRvcG8gSWRcbiAqL1xuZnVuY3Rpb24gY29tcGlsZVZhcmlhYmxlUmVmZXJlbmNlKHN0YXJ0VG9wb0lkLCB2YXJPb2wsIGNvbXBpbGVDb250ZXh0KSB7XG4gICAgcHJlOiBfLmlzUGxhaW5PYmplY3QodmFyT29sKSAmJiB2YXJPb2wub29sVHlwZSA9PT0gJ09iamVjdFJlZmVyZW5jZSc7XG5cbiAgICAvL2xldCBbIGJhc2VOYW1lLCBvdGhlcnMgXSA9IHZhck9vbC5uYW1lLnNwbGl0KCcuJywgMik7XG4gICAgLypcbiAgICBpZiAoY29tcGlsZUNvbnRleHQubW9kZWxWYXJzICYmIGNvbXBpbGVDb250ZXh0Lm1vZGVsVmFycy5oYXMoYmFzZU5hbWUpICYmIG90aGVycykge1xuICAgICAgICB2YXJPb2wubmFtZSA9IGJhc2VOYW1lICsgJy5kYXRhJyArICcuJyArIG90aGVycztcbiAgICB9Ki8gICAgXG5cbiAgICAvL3NpbXBsZSB2YWx1ZVxuICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtzdGFydFRvcG9JZF0gPSBKc0xhbmcuYXN0VmFsdWUodmFyT29sKTtcbiAgICByZXR1cm4gc3RhcnRUb3BvSWQ7XG59XG5cbi8qKlxuICogR2V0IGFuIGFycmF5IG9mIHBhcmFtZXRlciBuYW1lcy5cbiAqIEBwYXJhbSB7YXJyYXl9IGFyZ3MgLSBBbiBhcnJheSBvZiBhcmd1bWVudHMgaW4gb29sIHN5bnRheFxuICogQHJldHVybnMge2FycmF5fVxuICovXG5mdW5jdGlvbiB0cmFuc2xhdGVGdW5jdGlvblBhcmFtcyhhcmdzKSB7XG4gICAgaWYgKF8uaXNFbXB0eShhcmdzKSkgcmV0dXJuIFtdO1xuXG4gICAgbGV0IG5hbWVzID0gbmV3IFNldCgpO1xuXG4gICAgZnVuY3Rpb24gdHJhbnNsYXRlRnVuY3Rpb25QYXJhbShhcmcsIGkpIHtcbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChhcmcpKSB7XG4gICAgICAgICAgICBpZiAoYXJnLm9vbFR5cGUgPT09ICdQaXBlZFZhbHVlJykge1xuICAgICAgICAgICAgICAgIHJldHVybiB0cmFuc2xhdGVGdW5jdGlvblBhcmFtKGFyZy52YWx1ZSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChhcmcub29sVHlwZSA9PT0gJ09iamVjdFJlZmVyZW5jZScpIHtcbiAgICAgICAgICAgICAgICBpZiAoaXNEb3RTZXBhcmF0ZU5hbWUoYXJnLm5hbWUpKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBleHRyYWN0RG90U2VwYXJhdGVOYW1lKGFyZy5uYW1lKS5wb3AoKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIHJldHVybiBhcmcubmFtZTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiAncGFyYW0nICsgKGkgKyAxKS50b1N0cmluZygpO1xuICAgIH1cblxuICAgIHJldHVybiBfLm1hcChhcmdzLCAoYXJnLCBpKSA9PiB7XG4gICAgICAgIGxldCBiYXNlTmFtZSA9IHRyYW5zbGF0ZUZ1bmN0aW9uUGFyYW0oYXJnLCBpKTtcbiAgICAgICAgbGV0IG5hbWUgPSBiYXNlTmFtZTtcbiAgICAgICAgbGV0IGNvdW50ID0gMjtcbiAgICAgICAgXG4gICAgICAgIHdoaWxlIChuYW1lcy5oYXMobmFtZSkpIHtcbiAgICAgICAgICAgIG5hbWUgPSBiYXNlTmFtZSArIGNvdW50LnRvU3RyaW5nKCk7XG4gICAgICAgICAgICBjb3VudCsrO1xuICAgICAgICB9XG5cbiAgICAgICAgbmFtZXMuYWRkKG5hbWUpO1xuICAgICAgICByZXR1cm4gbmFtZTsgICAgICAgIFxuICAgIH0pO1xufVxuXG4vKipcbiAqIENvbXBpbGUgYSBjb25jcmV0ZSB2YWx1ZSBleHByZXNzaW9uIGZyb20gb29sIHRvIGFzdFxuICogQHBhcmFtIHtzdHJpbmd9IHN0YXJ0VG9wb0lkIC0gVGhlIHRvcG8gaWQgb2YgdGhlIHN0YXJ0aW5nIHByb2Nlc3MgdG8gdGhlIHRhcmdldCB2YWx1ZSBleHByZXNzaW9uXG4gKiBAcGFyYW0ge29iamVjdH0gdmFsdWUgLSBPb2wgbm9kZVxuICogQHBhcmFtIHtvYmplY3R9IGNvbXBpbGVDb250ZXh0IC0gQ29tcGlsYXRpb24gY29udGV4dFxuICogQHJldHVybnMge3N0cmluZ30gTGFzdCB0b3BvSWRcbiAqL1xuZnVuY3Rpb24gY29tcGlsZUNvbmNyZXRlVmFsdWVFeHByZXNzaW9uKHN0YXJ0VG9wb0lkLCB2YWx1ZSwgY29tcGlsZUNvbnRleHQpIHtcbiAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHZhbHVlKSkge1xuICAgICAgICBpZiAodmFsdWUub29sVHlwZSA9PT0gJ1BpcGVkVmFsdWUnKSB7XG4gICAgICAgICAgICByZXR1cm4gY29tcGlsZVBpcGVkVmFsdWUoc3RhcnRUb3BvSWQsIHZhbHVlLCBjb21waWxlQ29udGV4dCk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAodmFsdWUub29sVHlwZSA9PT0gJ09iamVjdFJlZmVyZW5jZScpIHtcbiAgICAgICAgICAgIGxldCBbIHJlZkJhc2UsIC4uLnJlc3QgXSA9IGV4dHJhY3REb3RTZXBhcmF0ZU5hbWUodmFsdWUubmFtZSk7XG5cbiAgICAgICAgICAgIGxldCBkZXBlbmRlbmN5O1xuXG4gICAgICAgICAgICBpZiAoIWNvbXBpbGVDb250ZXh0LnZhcmlhYmxlc1tyZWZCYXNlXSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgUmVmZXJlbmNlZCB1bmRlZmluZWQgdmFyaWFibGU6ICR7dmFsdWUubmFtZX1gKTsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICBpZiAoY29tcGlsZUNvbnRleHQudmFyaWFibGVzW3JlZkJhc2VdLnR5cGUgPT09ICdlbnRpdHknICYmICFjb21waWxlQ29udGV4dC52YXJpYWJsZXNbcmVmQmFzZV0ub25nb2luZykge1xuICAgICAgICAgICAgICAgIGRlcGVuZGVuY3kgPSByZWZCYXNlO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChyZWZCYXNlID09PSAnbGF0ZXN0JyAmJiByZXN0Lmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgICAgICAvL2xhdGVzdC5wYXNzd29yZFxuICAgICAgICAgICAgICAgIGxldCByZWZGaWVsZE5hbWUgPSByZXN0LnBvcCgpO1xuICAgICAgICAgICAgICAgIGlmIChyZWZGaWVsZE5hbWUgIT09IHN0YXJ0VG9wb0lkKSB7XG4gICAgICAgICAgICAgICAgICAgIGRlcGVuZGVuY3kgPSByZWZGaWVsZE5hbWUgKyAnOnJlYWR5JztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2UgaWYgKF8uaXNFbXB0eShyZXN0KSkge1xuICAgICAgICAgICAgICAgIGRlcGVuZGVuY3kgPSByZWZCYXNlICsgJzpyZWFkeSc7XG4gICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICBpZiAoZGVwZW5kZW5jeSkge1xuICAgICAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgZGVwZW5kZW5jeSwgc3RhcnRUb3BvSWQpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gY29tcGlsZVZhcmlhYmxlUmVmZXJlbmNlKHN0YXJ0VG9wb0lkLCB2YWx1ZSwgY29tcGlsZUNvbnRleHQpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHZhbHVlLm9vbFR5cGUgPT09ICdSZWdFeHAnKSB7XG4gICAgICAgICAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbc3RhcnRUb3BvSWRdID0gSnNMYW5nLmFzdFZhbHVlKHZhbHVlKTsgICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiBzdGFydFRvcG9JZDtcbiAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgdmFsdWUgPSBfLm1hcFZhbHVlcyh2YWx1ZSwgKHZhbHVlT2ZFbGVtZW50LCBrZXkpID0+IHsgXG4gICAgICAgICAgICBsZXQgc2lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCArICcuJyArIGtleSk7XG4gICAgICAgICAgICBsZXQgZWlkID0gY29tcGlsZUNvbmNyZXRlVmFsdWVFeHByZXNzaW9uKHNpZCwgdmFsdWVPZkVsZW1lbnQsIGNvbXBpbGVDb250ZXh0KTtcbiAgICAgICAgICAgIGlmIChzaWQgIT09IGVpZCkge1xuICAgICAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgZWlkLCBzdGFydFRvcG9JZCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gY29tcGlsZUNvbnRleHQuYXN0TWFwW2VpZF07XG4gICAgICAgIH0pO1xuICAgIH0gZWxzZSBpZiAoQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHtcbiAgICAgICAgdmFsdWUgPSBfLm1hcCh2YWx1ZSwgKHZhbHVlT2ZFbGVtZW50LCBpbmRleCkgPT4geyBcbiAgICAgICAgICAgIGxldCBzaWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkICsgJ1snICsgaW5kZXggKyAnXScpO1xuICAgICAgICAgICAgbGV0IGVpZCA9IGNvbXBpbGVDb25jcmV0ZVZhbHVlRXhwcmVzc2lvbihzaWQsIHZhbHVlT2ZFbGVtZW50LCBjb21waWxlQ29udGV4dCk7XG4gICAgICAgICAgICBpZiAoc2lkICE9PSBlaWQpIHtcbiAgICAgICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIGVpZCwgc3RhcnRUb3BvSWQpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtlaWRdO1xuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbc3RhcnRUb3BvSWRdID0gSnNMYW5nLmFzdFZhbHVlKHZhbHVlKTtcbiAgICByZXR1cm4gc3RhcnRUb3BvSWQ7XG59XG5cbi8qKlxuICogVHJhbnNsYXRlIGFuIGFycmF5IG9mIGZ1bmN0aW9uIGFyZ3VtZW50cyBmcm9tIG9vbCBpbnRvIGFzdC5cbiAqIEBwYXJhbSB0b3BvSWQgLSBUaGUgbW9kaWZpZXIgZnVuY3Rpb24gdG9wbyBcbiAqIEBwYXJhbSBhcmdzIC0gXG4gKiBAcGFyYW0gY29tcGlsZUNvbnRleHQgLSBcbiAqIEByZXR1cm5zIHtBcnJheX1cbiAqL1xuZnVuY3Rpb24gdHJhbnNsYXRlQXJncyh0b3BvSWQsIGFyZ3MsIGNvbXBpbGVDb250ZXh0KSB7XG4gICAgYXJncyA9IF8uY2FzdEFycmF5KGFyZ3MpO1xuICAgIGlmIChfLmlzRW1wdHkoYXJncykpIHJldHVybiBbXTtcblxuICAgIGxldCBjYWxsQXJncyA9IFtdO1xuXG4gICAgXy5lYWNoKGFyZ3MsIChhcmcsIGkpID0+IHsgICAgICAgICAgICAgICAgXG4gICAgICAgIGxldCBhcmdUb3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIHRvcG9JZCArICc6YXJnWycgKyAoaSsxKS50b1N0cmluZygpICsgJ10nKTtcbiAgICAgICAgbGV0IGxhc3RUb3BvSWQgPSBjb21waWxlQ29uY3JldGVWYWx1ZUV4cHJlc3Npb24oYXJnVG9wb0lkLCBhcmcsIGNvbXBpbGVDb250ZXh0KTtcblxuICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIGxhc3RUb3BvSWQsIHRvcG9JZCk7XG5cbiAgICAgICAgY2FsbEFyZ3MgPSBjYWxsQXJncy5jb25jYXQoXy5jYXN0QXJyYXkoZ2V0Q29kZVJlcHJlc2VudGF0aW9uT2YobGFzdFRvcG9JZCwgY29tcGlsZUNvbnRleHQpKSk7XG4gICAgfSk7XG5cbiAgICByZXR1cm4gY2FsbEFyZ3M7XG59XG5cbi8qKlxuICogQ29tcGlsZSBhIHBhcmFtIG9mIGludGVyZmFjZSBmcm9tIG9vbCBpbnRvIGFzdFxuICogQHBhcmFtIGluZGV4XG4gKiBAcGFyYW0gcGFyYW1cbiAqIEBwYXJhbSBjb21waWxlQ29udGV4dFxuICogQHJldHVybnMge3N0cmluZ31cbiAqL1xuZnVuY3Rpb24gY29tcGlsZVBhcmFtKGluZGV4LCBwYXJhbSwgY29tcGlsZUNvbnRleHQpIHtcbiAgICBsZXQgdHlwZSA9IHBhcmFtLnR5cGU7ICAgIFxuXG4gICAgbGV0IHR5cGVPYmplY3QgPSBUeXBlc1t0eXBlXTtcblxuICAgIGlmICghdHlwZU9iamVjdCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1Vua25vd24gZmllbGQgdHlwZTogJyArIHR5cGUpO1xuICAgIH1cblxuICAgIGxldCBzYW5pdGl6ZXJOYW1lID0gYFR5cGVzLiR7dHlwZS50b1VwcGVyQ2FzZSgpfS5zYW5pdGl6ZWA7XG5cbiAgICBsZXQgdmFyUmVmID0gSnNMYW5nLmFzdFZhclJlZihwYXJhbS5uYW1lKTtcbiAgICBsZXQgY2FsbEFzdCA9IEpzTGFuZy5hc3RDYWxsKHNhbml0aXplck5hbWUsIFt2YXJSZWYsIEpzTGFuZy5hc3RBcnJheUFjY2VzcygnJG1ldGEucGFyYW1zJywgaW5kZXgpLCBKc0xhbmcuYXN0VmFyUmVmKCd0aGlzLmRiLmkxOG4nKV0pO1xuXG4gICAgbGV0IHByZXBhcmVUb3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsICckcGFyYW1zOnNhbml0aXplWycgKyBpbmRleC50b1N0cmluZygpICsgJ10nKTtcbiAgICAvL2xldCBzYW5pdGl6ZVN0YXJ0aW5nO1xuXG4gICAgLy9pZiAoaW5kZXggPT09IDApIHtcbiAgICAgICAgLy9kZWNsYXJlICRzYW5pdGl6ZVN0YXRlIHZhcmlhYmxlIGZvciB0aGUgZmlyc3QgdGltZVxuICAgIC8vICAgIHNhbml0aXplU3RhcnRpbmcgPSBKc0xhbmcuYXN0VmFyRGVjbGFyZSh2YXJSZWYsIGNhbGxBc3QsIGZhbHNlLCBmYWxzZSwgYFNhbml0aXplIHBhcmFtIFwiJHtwYXJhbS5uYW1lfVwiYCk7XG4gICAgLy99IGVsc2Uge1xuICAgIC8vbGV0IHNhbml0aXplU3RhcnRpbmcgPSA7XG5cbiAgICAgICAgLy9sZXQgbGFzdFByZXBhcmVUb3BvSWQgPSAnJHBhcmFtczpzYW5pdGl6ZVsnICsgKGluZGV4IC0gMSkudG9TdHJpbmcoKSArICddJztcbiAgICAgICAgLy9kZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIGxhc3RQcmVwYXJlVG9wb0lkLCBwcmVwYXJlVG9wb0lkKTtcbiAgICAvL31cblxuICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtwcmVwYXJlVG9wb0lkXSA9IFtcbiAgICAgICAgSnNMYW5nLmFzdEFzc2lnbih2YXJSZWYsIGNhbGxBc3QsIGBTYW5pdGl6ZSBhcmd1bWVudCBcIiR7cGFyYW0ubmFtZX1cImApXG4gICAgXTtcblxuICAgIGFkZENvZGVCbG9jayhjb21waWxlQ29udGV4dCwgcHJlcGFyZVRvcG9JZCwge1xuICAgICAgICB0eXBlOiBBU1RfQkxLX1BBUkFNX1NBTklUSVpFXG4gICAgfSk7XG5cbiAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIHByZXBhcmVUb3BvSWQsIGNvbXBpbGVDb250ZXh0Lm1haW5TdGFydElkKTtcblxuICAgIGxldCB0b3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIHBhcmFtLm5hbWUpO1xuICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgY29tcGlsZUNvbnRleHQubWFpblN0YXJ0SWQsIHRvcG9JZCk7XG5cbiAgICBsZXQgdmFsdWUgPSB3cmFwUGFyYW1SZWZlcmVuY2UocGFyYW0ubmFtZSwgcGFyYW0pO1xuICAgIGxldCBlbmRUb3BvSWQgPSBjb21waWxlVmFyaWFibGVSZWZlcmVuY2UodG9wb0lkLCB2YWx1ZSwgY29tcGlsZUNvbnRleHQpO1xuXG4gICAgbGV0IHJlYWR5VG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCB0b3BvSWQgKyAnOnJlYWR5Jyk7XG4gICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBlbmRUb3BvSWQsIHJlYWR5VG9wb0lkKTtcblxuICAgIHJldHVybiByZWFkeVRvcG9JZDtcbn1cblxuLyoqXG4gKiBDb21waWxlIGEgbW9kZWwgZmllbGQgcHJlcHJvY2VzcyBpbmZvcm1hdGlvbiBpbnRvIGFzdC5cbiAqIEBwYXJhbSB7b2JqZWN0fSBwYXJhbSAtIEZpZWxkIGluZm9ybWF0aW9uXG4gKiBAcGFyYW0ge29iamVjdH0gY29tcGlsZUNvbnRleHQgLSBDb21waWxhdGlvbiBjb250ZXh0XG4gKiBAcmV0dXJucyB7c3RyaW5nfVxuICovXG5mdW5jdGlvbiBjb21waWxlRmllbGQocGFyYW1OYW1lLCBwYXJhbSwgY29tcGlsZUNvbnRleHQpIHtcbiAgICAvLyAxLiByZWZlcmVuY2UgdG8gdGhlIGxhdGVzdCBvYmplY3QgdGhhdCBpcyBwYXNzZWQgcXVhbGlmaWVyIGNoZWNrc1xuICAgIC8vIDIuIGlmIG1vZGlmaWVycyBleGlzdCwgd3JhcCB0aGUgcmVmIGludG8gYSBwaXBlZCB2YWx1ZVxuICAgIC8vIDMuIHByb2Nlc3MgdGhlIHJlZiAob3IgcGlwZWQgcmVmKSBhbmQgbWFyayBhcyBlbmRcbiAgICAvLyA0LiBidWlsZCBkZXBlbmRlbmNpZXM6IGxhdGVzdC5maWVsZCAtPiAuLi4gLT4gZmllbGQ6cmVhZHkgXG4gICAgbGV0IHRvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgcGFyYW1OYW1lKTtcbiAgICBsZXQgY29udGV4dE5hbWUgPSAnbGF0ZXN0LicgKyBwYXJhbU5hbWU7XG4gICAgLy9jb21waWxlQ29udGV4dC5hc3RNYXBbdG9wb0lkXSA9IEpzTGFuZy5hc3RWYXJSZWYoY29udGV4dE5hbWUsIHRydWUpO1xuXG4gICAgbGV0IHZhbHVlID0gd3JhcFBhcmFtUmVmZXJlbmNlKGNvbnRleHROYW1lLCBwYXJhbSk7ICAgIFxuICAgIGxldCBlbmRUb3BvSWQgPSBjb21waWxlQ29uY3JldGVWYWx1ZUV4cHJlc3Npb24odG9wb0lkLCB2YWx1ZSwgY29tcGlsZUNvbnRleHQpO1xuXG4gICAgbGV0IHJlYWR5VG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCB0b3BvSWQgKyAnOnJlYWR5Jyk7XG4gICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBlbmRUb3BvSWQsIHJlYWR5VG9wb0lkKTtcblxuICAgIHJldHVybiByZWFkeVRvcG9JZDtcbn1cblxuZnVuY3Rpb24gd3JhcFBhcmFtUmVmZXJlbmNlKG5hbWUsIHZhbHVlKSB7XG4gICAgbGV0IHJlZiA9IE9iamVjdC5hc3NpZ24oeyBvb2xUeXBlOiAnT2JqZWN0UmVmZXJlbmNlJywgbmFtZTogbmFtZSB9KTtcbiAgICBcbiAgICBpZiAoIV8uaXNFbXB0eSh2YWx1ZS5tb2RpZmllcnMpKSB7XG4gICAgICAgIHJldHVybiB7IG9vbFR5cGU6ICdQaXBlZFZhbHVlJywgdmFsdWU6IHJlZiwgbW9kaWZpZXJzOiB2YWx1ZS5tb2RpZmllcnMgfTtcbiAgICB9XG4gICAgXG4gICAgcmV0dXJuIHJlZjtcbn1cblxuZnVuY3Rpb24gaGFzTW9kZWxGaWVsZChvcGVyYW5kLCBjb21waWxlQ29udGV4dCkge1xuICAgIGlmIChfLmlzUGxhaW5PYmplY3Qob3BlcmFuZCkgJiYgb3BlcmFuZC5vb2xUeXBlID09PSAnT2JqZWN0UmVmZXJlbmNlJykge1xuICAgICAgICBsZXQgWyBiYXNlVmFyLCAuLi5yZXN0IF0gPSBvcGVyYW5kLm5hbWUuc3BsaXQoJy4nKTtcblxuICAgICAgICByZXR1cm4gY29tcGlsZUNvbnRleHQudmFyaWFibGVzW2Jhc2VWYXJdICYmIGNvbXBpbGVDb250ZXh0LnZhcmlhYmxlc1tiYXNlVmFyXS5vbmdvaW5nICYmIHJlc3QubGVuZ3RoID4gMDsgICAgICAgIFxuICAgIH1cblxuICAgIHJldHVybiBmYWxzZTsgICAgXG59XG5cbi8qKlxuICogVHJhbnNsYXRlIGEgdGhlbiBjbGF1c2UgZnJvbSBvb2wgaW50byBhc3QgaW4gcmV0dXJuIGJsb2NrLlxuICogQHBhcmFtIHtzdHJpbmd9IHN0YXJ0SWRcbiAqIEBwYXJhbSB7c3RyaW5nfSBlbmRJZFxuICogQHBhcmFtIHRoZW5cbiAqIEBwYXJhbSBjb21waWxlQ29udGV4dFxuICogQHJldHVybnMge29iamVjdH0gQVNUIG9iamVjdFxuICovXG5mdW5jdGlvbiB0cmFuc2xhdGVSZXR1cm5UaGVuQXN0KHN0YXJ0SWQsIGVuZElkLCB0aGVuLCBjb21waWxlQ29udGV4dCkge1xuICAgIGlmIChfLmlzUGxhaW5PYmplY3QodGhlbikpIHtcbiAgICAgICAgaWYgKHRoZW4ub29sVHlwZSA9PT0gJ1Rocm93RXhwcmVzc2lvbicpIHtcbiAgICAgICAgICAgIGxldCBhcmdzO1xuICAgICAgICAgICAgaWYgKHRoZW4uYXJncykge1xuICAgICAgICAgICAgICAgIGFyZ3MgPSB0cmFuc2xhdGVBcmdzKHN0YXJ0SWQsIHRoZW4uYXJncywgY29tcGlsZUNvbnRleHQpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBhcmdzID0gW107XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gSnNMYW5nLmFzdFRocm93KHRoZW4uZXJyb3JUeXBlIHx8IGRlZmF1bHRFcnJvciwgdGhlbi5tZXNzYWdlIHx8IGFyZ3MpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHRoZW4ub29sVHlwZSA9PT0gJ1JldHVybkV4cHJlc3Npb24nKSB7XG4gICAgICAgICAgICByZXR1cm4gdHJhbnNsYXRlUmV0dXJuVmFsdWVBc3Qoc3RhcnRJZCwgZW5kSWQsIHRoZW4udmFsdWUsIGNvbXBpbGVDb250ZXh0KTtcbiAgICAgICAgfSAgICAgICAgXG4gICAgfVxuXG4gICAgLy90aGVuIGV4cHJlc3Npb24gaXMgYW4gb29sb25nIGNvbmNyZXRlIHZhbHVlICAgIFxuICAgIGlmIChfLmlzQXJyYXkodGhlbikgfHwgXy5pc1BsYWluT2JqZWN0KHRoZW4pKSB7XG4gICAgICAgIGxldCB2YWx1ZUVuZElkID0gY29tcGlsZUNvbmNyZXRlVmFsdWVFeHByZXNzaW9uKHN0YXJ0SWQsIHRoZW4sIGNvbXBpbGVDb250ZXh0KTsgICAgXG4gICAgICAgIHRoZW4gPSBjb21waWxlQ29udGV4dC5hc3RNYXBbdmFsdWVFbmRJZF07IFxuICAgIH0gICBcblxuICAgIHJldHVybiBKc0xhbmcuYXN0UmV0dXJuKHRoZW4pO1xufVxuXG4vKipcbiAqIFRyYW5zbGF0ZSBhIHRoZW4gY2xhdXNlIGZyb20gb29sIGludG8gYXN0XG4gKiBAcGFyYW0ge3N0cmluZ30gc3RhcnRJZFxuICogQHBhcmFtIHtzdHJpbmd9IGVuZElkXG4gKiBAcGFyYW0gdGhlblxuICogQHBhcmFtIGNvbXBpbGVDb250ZXh0XG4gKiBAcGFyYW0gYXNzaWduVG9cbiAqIEByZXR1cm5zIHtvYmplY3R9IEFTVCBvYmplY3RcbiAqL1xuZnVuY3Rpb24gdHJhbnNsYXRlVGhlbkFzdChzdGFydElkLCBlbmRJZCwgdGhlbiwgY29tcGlsZUNvbnRleHQsIGFzc2lnblRvKSB7XG4gICAgaWYgKF8uaXNQbGFpbk9iamVjdCh0aGVuKSkge1xuICAgICAgICBpZiAodGhlbi5vb2xUeXBlID09PSAnVGhyb3dFeHByZXNzaW9uJykge1xuICAgICAgICAgICAgbGV0IGFyZ3M7XG4gICAgICAgICAgICBpZiAodGhlbi5hcmdzKSB7XG4gICAgICAgICAgICAgICAgYXJncyA9IHRyYW5zbGF0ZUFyZ3Moc3RhcnRJZCwgdGhlbi5hcmdzLCBjb21waWxlQ29udGV4dCk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGFyZ3MgPSBbXTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiBKc0xhbmcuYXN0VGhyb3codGhlbi5lcnJvclR5cGUgfHwgZGVmYXVsdEVycm9yLCB0aGVuLm1lc3NhZ2UgfHwgYXJncyk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAodGhlbi5vb2xUeXBlID09PSAnTG9naWNhbEV4cHJlc3Npb24nKSB7XG4gICAgICAgICAgICAvKlxuICAgICAgICAgICAgc3dpdGNoICh0aGVuLm9wZXJhdG9yKSB7XG4gICAgICAgICAgICAgICAgY2FzZSAnYW5kJzpcbiAgICAgICAgICAgICAgICAgICAgb3AgPSAnJiYnO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgICAgIGNhc2UgJ29yJzpcbiAgICAgICAgICAgICAgICAgICAgb3AgPSAnfHwnO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5zdXBwb3J0ZWQgdGVzdCBvcGVyYXRvcjogJyArIHRlc3Qub3BlcmF0b3IpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgKi9cbiAgICAgICAgfVxuXG4gICAgICAgIGlmICh0aGVuLm9vbFR5cGUgPT09ICdCaW5hcnlFeHByZXNzaW9uJykge1xuICAgICAgICAgICAgaWYgKCFoYXNNb2RlbEZpZWxkKHRoZW4ubGVmdCwgY29tcGlsZUNvbnRleHQpKSB7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignSW52YWxpZCBxdWVyeSBjb25kaXRpb246IHRoZSBsZWZ0IG9wZXJhbmQgbmVlZCB0byBiZSBhbiBlbnRpdHkgZmllbGQuJyk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChoYXNNb2RlbEZpZWxkKHRoZW4ucmlnaHQsIGNvbXBpbGVDb250ZXh0KSkgeyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ0ludmFsaWQgcXVlcnkgY29uZGl0aW9uOiB0aGUgcmlnaHQgb3BlcmFuZCBzaG91bGQgbm90IGJlIGFuIGVudGl0eSBmaWVsZC4gVXNlIGRhdGFzZXQgaW5zdGVhZCBpZiBqb2luaW5nIGlzIHJlcXVpcmVkLicpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgY29uZGl0aW9uID0ge307XG4gICAgICAgICAgICBsZXQgc3RhcnRSaWdodElkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBzdGFydElkICsgJyRiaW5PcDpyaWdodCcpO1xuICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBzdGFydElkLCBzdGFydFJpZ2h0SWQpO1xuXG4gICAgICAgICAgICBsZXQgbGFzdFJpZ2h0SWQgPSBjb21waWxlQ29uY3JldGVWYWx1ZUV4cHJlc3Npb24oc3RhcnRSaWdodElkLCB0aGVuLnJpZ2h0LCBjb21waWxlQ29udGV4dCk7XG4gICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIGxhc3RSaWdodElkLCBlbmRJZCk7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGlmICh0aGVuLm9wZXJhdG9yID09PSAnPT0nKSB7XG4gICAgICAgICAgICAgICAgY29uZGl0aW9uW3RoZW4ubGVmdC5uYW1lLnNwbGl0KCcuJywgMilbMV1dID0gY29tcGlsZUNvbnRleHQuYXN0TWFwW2xhc3RSaWdodElkXTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgY29uZGl0aW9uW3RoZW4ubGVmdC5uYW1lLnNwbGl0KCcuJywgMilbMV1dID0geyBbT1BFUkFUT1JfVE9LRU5bb3BdXTogY29tcGlsZUNvbnRleHQuYXN0TWFwW2xhc3RSaWdodElkXSB9O1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gSnNMYW5nLmFzdEFzc2lnbihhc3NpZ25UbywgSnNMYW5nLmFzdFZhbHVlKGNvbmRpdGlvbikpOyAgICAgICAgICAgXG4gICAgICAgIH1cblxuICAgICAgICBpZiAodGhlbi5vb2xUeXBlID09PSAnVW5hcnlFeHByZXNzaW9uJykge1xuICAgICAgICAgICAgXG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvL3RoZW4gZXhwcmVzc2lvbiBpcyBhbiBvb2xvbmcgY29uY3JldGUgdmFsdWUgICAgXG4gICAgaWYgKF8uaXNBcnJheSh0aGVuKSB8fCBfLmlzUGxhaW5PYmplY3QodGhlbikpIHtcbiAgICAgICAgbGV0IHZhbHVlRW5kSWQgPSBjb21waWxlQ29uY3JldGVWYWx1ZUV4cHJlc3Npb24oc3RhcnRJZCwgdGhlbiwgY29tcGlsZUNvbnRleHQpOyAgICBcbiAgICAgICAgdGhlbiA9IGNvbXBpbGVDb250ZXh0LmFzdE1hcFt2YWx1ZUVuZElkXTsgXG4gICAgfSAgIFxuXG4gICAgcmV0dXJuIEpzTGFuZy5hc3RBc3NpZ24oYXNzaWduVG8sIHRoZW4pO1xufVxuXG4vKipcbiAqIFRyYW5zbGF0ZSBhIHJldHVybiBjbGF1c2UgZnJvbSBvb2wgaW50byBhc3RcbiAqIEBwYXJhbSB7c3RyaW5nfSBzdGFydFRvcG9JZCAtIFRoZSB0b3BvIGlkIG9mIHRoZSBzdGFydGluZyBzdGF0ZSBvZiByZXR1cm4gY2xhdXNlXG4gKiBAcGFyYW0ge3N0cmluZ30gZW5kVG9wb0lkIC0gVGhlIHRvcG8gaWQgb2YgdGhlIGVuZGluZyBzdGF0ZSBvZiByZXR1cm4gY2xhdXNlXG4gKiBAcGFyYW0gdmFsdWVcbiAqIEBwYXJhbSBjb21waWxlQ29udGV4dFxuICogQHJldHVybnMge29iamVjdH0gQVNUIG9iamVjdFxuICovXG5mdW5jdGlvbiB0cmFuc2xhdGVSZXR1cm5WYWx1ZUFzdChzdGFydFRvcG9JZCwgZW5kVG9wb0lkLCB2YWx1ZSwgY29tcGlsZUNvbnRleHQpIHtcbiAgICBsZXQgdmFsdWVUb3BvSWQgPSBjb21waWxlQ29uY3JldGVWYWx1ZUV4cHJlc3Npb24oc3RhcnRUb3BvSWQsIHZhbHVlLCBjb21waWxlQ29udGV4dCk7XG4gICAgaWYgKHZhbHVlVG9wb0lkICE9PSBzdGFydFRvcG9JZCkge1xuICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIHZhbHVlVG9wb0lkLCBlbmRUb3BvSWQpO1xuICAgIH1cblxuICAgIHJldHVybiBKc0xhbmcuYXN0UmV0dXJuKGdldENvZGVSZXByZXNlbnRhdGlvbk9mKHZhbHVlVG9wb0lkLCBjb21waWxlQ29udGV4dCkpO1xufVxuXG4vKipcbiAqIENvbXBpbGUgYSByZXR1cm4gY2xhdXNlIGZyb20gb29sIGludG8gYXN0XG4gKiBAcGFyYW0ge3N0cmluZ30gc3RhcnRUb3BvSWQgLSBUaGUgdG9wbyBpZCBvZiB0aGUgc3RhcnRpbmcgcHJvY2VzcyB0byB0aGUgdGFyZ2V0IHZhbHVlIGV4cHJlc3Npb25cbiAqIEBwYXJhbSB2YWx1ZVxuICogQHBhcmFtIGNvbXBpbGVDb250ZXh0XG4gKiBAcmV0dXJucyB7b2JqZWN0fSBBU1Qgb2JqZWN0XG4gKi9cbmZ1bmN0aW9uIGNvbXBpbGVSZXR1cm4oc3RhcnRUb3BvSWQsIHZhbHVlLCBjb21waWxlQ29udGV4dCkge1xuICAgIGxldCBlbmRUb3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsICckcmV0dXJuJyk7XG4gICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCwgZW5kVG9wb0lkKTtcblxuICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtlbmRUb3BvSWRdID0gdHJhbnNsYXRlUmV0dXJuVmFsdWVBc3Qoc3RhcnRUb3BvSWQsIGVuZFRvcG9JZCwgdmFsdWUsIGNvbXBpbGVDb250ZXh0KTtcblxuICAgIGFkZENvZGVCbG9jayhjb21waWxlQ29udGV4dCwgZW5kVG9wb0lkLCB7XG4gICAgICAgIHR5cGU6IEFTVF9CTEtfVklFV19SRVRVUk5cbiAgICB9KTtcblxuICAgIHJldHVybiBlbmRUb3BvSWQ7XG59XG5cbi8qKlxuICogQ29tcGlsZSBhIGZpbmQgb25lIG9wZXJhdGlvbiBmcm9tIG9vbCBpbnRvIGFzdFxuICogQHBhcmFtIHtpbnR9IGluZGV4XG4gKiBAcGFyYW0ge29iamVjdH0gb3BlcmF0aW9uIC0gT29sIG5vZGVcbiAqIEBwYXJhbSB7b2JqZWN0fSBjb21waWxlQ29udGV4dCAtXG4gKiBAcGFyYW0ge3N0cmluZ30gZGVwZW5kZW5jeVxuICogQHJldHVybnMge3N0cmluZ30gbGFzdCB0b3BvSWRcbiAqL1xuZnVuY3Rpb24gY29tcGlsZUZpbmRPbmUoaW5kZXgsIG9wZXJhdGlvbiwgY29tcGlsZUNvbnRleHQsIGRlcGVuZGVuY3kpIHtcbiAgICBwcmU6IGRlcGVuZGVuY3k7XG5cbiAgICBsZXQgZW5kVG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCAnb3AkJyArIGluZGV4LnRvU3RyaW5nKCkpO1xuICAgIGxldCBjb25kaXRpb25WYXJOYW1lID0gZW5kVG9wb0lkICsgJyRjb25kaXRpb24nO1xuXG4gICAgbGV0IGFzdCA9IFtcbiAgICAgICAgSnNMYW5nLmFzdFZhckRlY2xhcmUoY29uZGl0aW9uVmFyTmFtZSlcbiAgICBdO1xuXG4gICAgYXNzZXJ0OiBvcGVyYXRpb24uY29uZGl0aW9uO1xuXG4gICAgY29tcGlsZUNvbnRleHQudmFyaWFibGVzW29wZXJhdGlvbi5tb2RlbF0gPSB7IHR5cGU6ICdlbnRpdHknLCBzb3VyY2U6ICdmaW5kT25lJywgb25nb2luZzogdHJ1ZSB9O1xuXG4gICAgaWYgKG9wZXJhdGlvbi5jb25kaXRpb24ub29sVHlwZSkge1xuICAgICAgICAvL3NwZWNpYWwgY29uZGl0aW9uXG5cbiAgICAgICAgaWYgKG9wZXJhdGlvbi5jb25kaXRpb24ub29sVHlwZSA9PT0gJ2Nhc2VzJykge1xuICAgICAgICAgICAgbGV0IHRvcG9JZFByZWZpeCA9IGVuZFRvcG9JZCArICckY2FzZXMnO1xuICAgICAgICAgICAgbGV0IGxhc3RTdGF0ZW1lbnQ7XG5cbiAgICAgICAgICAgIGlmIChvcGVyYXRpb24uY29uZGl0aW9uLmVsc2UpIHtcbiAgICAgICAgICAgICAgICBsZXQgZWxzZVN0YXJ0ID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCB0b3BvSWRQcmVmaXggKyAnOmVsc2UnKTtcbiAgICAgICAgICAgICAgICBsZXQgZWxzZUVuZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgdG9wb0lkUHJlZml4ICsgJzplbmQnKTtcbiAgICAgICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIGVsc2VTdGFydCwgZWxzZUVuZCk7XG4gICAgICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBlbHNlRW5kLCBlbmRUb3BvSWQpO1xuXG4gICAgICAgICAgICAgICAgbGFzdFN0YXRlbWVudCA9IHRyYW5zbGF0ZVRoZW5Bc3QoZWxzZVN0YXJ0LCBlbHNlRW5kLCBvcGVyYXRpb24uY29uZGl0aW9uLmVsc2UsIGNvbXBpbGVDb250ZXh0LCBjb25kaXRpb25WYXJOYW1lKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgbGFzdFN0YXRlbWVudCA9IEpzTGFuZy5hc3RUaHJvdygnU2VydmVyRXJyb3InLCAnVW5leHBlY3RlZCBzdGF0ZS4nKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKF8uaXNFbXB0eShvcGVyYXRpb24uY29uZGl0aW9uLml0ZW1zKSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignTWlzc2luZyBjYXNlIGl0ZW1zJyk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIF8ucmV2ZXJzZShvcGVyYXRpb24uY29uZGl0aW9uLml0ZW1zKS5mb3JFYWNoKChpdGVtLCBpKSA9PiB7XG4gICAgICAgICAgICAgICAgaWYgKGl0ZW0ub29sVHlwZSAhPT0gJ0NvbmRpdGlvbmFsU3RhdGVtZW50Jykge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ0ludmFsaWQgY2FzZSBpdGVtLicpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGkgPSBvcGVyYXRpb24uY29uZGl0aW9uLml0ZW1zLmxlbmd0aCAtIGkgLSAxO1xuXG4gICAgICAgICAgICAgICAgbGV0IGNhc2VQcmVmaXggPSB0b3BvSWRQcmVmaXggKyAnWycgKyBpLnRvU3RyaW5nKCkgKyAnXSc7XG4gICAgICAgICAgICAgICAgbGV0IGNhc2VUb3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIGNhc2VQcmVmaXgpO1xuICAgICAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgZGVwZW5kZW5jeSwgY2FzZVRvcG9JZCk7XG5cbiAgICAgICAgICAgICAgICBsZXQgY2FzZVJlc3VsdFZhck5hbWUgPSAnJCcgKyB0b3BvSWRQcmVmaXggKyAnXycgKyBpLnRvU3RyaW5nKCk7XG5cbiAgICAgICAgICAgICAgICBsZXQgbGFzdFRvcG9JZCA9IGNvbXBpbGVDb25kaXRpb25hbEV4cHJlc3Npb24oaXRlbS50ZXN0LCBjb21waWxlQ29udGV4dCwgY2FzZVRvcG9JZCk7XG4gICAgICAgICAgICAgICAgbGV0IGFzdENhc2VUdGVtID0gZ2V0Q29kZVJlcHJlc2VudGF0aW9uT2YobGFzdFRvcG9JZCwgY29tcGlsZUNvbnRleHQpO1xuXG4gICAgICAgICAgICAgICAgYXNzZXJ0OiAhQXJyYXkuaXNBcnJheShhc3RDYXNlVHRlbSksICdJbnZhbGlkIGNhc2UgaXRlbSBhc3QuJztcblxuICAgICAgICAgICAgICAgIGFzdENhc2VUdGVtID0gSnNMYW5nLmFzdFZhckRlY2xhcmUoY2FzZVJlc3VsdFZhck5hbWUsIGFzdENhc2VUdGVtLCB0cnVlLCBmYWxzZSwgYENvbmRpdGlvbiAke2l9IGZvciBmaW5kIG9uZSAke29wZXJhdGlvbi5tb2RlbH1gKTtcblxuICAgICAgICAgICAgICAgIGxldCBpZlN0YXJ0ID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBjYXNlUHJlZml4ICsgJzp0aGVuJyk7XG4gICAgICAgICAgICAgICAgbGV0IGlmRW5kID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBjYXNlUHJlZml4ICsgJzplbmQnKTtcbiAgICAgICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIGxhc3RUb3BvSWQsIGlmU3RhcnQpO1xuICAgICAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgaWZTdGFydCwgaWZFbmQpO1xuXG4gICAgICAgICAgICAgICAgbGFzdFN0YXRlbWVudCA9IFtcbiAgICAgICAgICAgICAgICAgICAgYXN0Q2FzZVR0ZW0sXG4gICAgICAgICAgICAgICAgICAgIEpzTGFuZy5hc3RJZihKc0xhbmcuYXN0VmFyUmVmKGNhc2VSZXN1bHRWYXJOYW1lKSwgSnNMYW5nLmFzdEJsb2NrKHRyYW5zbGF0ZVRoZW5Bc3QoaWZTdGFydCwgaWZFbmQsIGl0ZW0udGhlbiwgY29tcGlsZUNvbnRleHQsIGNvbmRpdGlvblZhck5hbWUpKSwgbGFzdFN0YXRlbWVudClcbiAgICAgICAgICAgICAgICBdO1xuICAgICAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgaWZFbmQsIGVuZFRvcG9JZCk7XG4gICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgYXN0ID0gYXN0LmNvbmNhdChfLmNhc3RBcnJheShsYXN0U3RhdGVtZW50KSk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ3RvZG8nKTtcbiAgICAgICAgfVxuXG5cbiAgICB9IGVsc2Uge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ3RvZG8nKTtcbiAgICB9XG5cbiAgICBhc3QucHVzaChcbiAgICAgICAgSnNMYW5nLmFzdFZhckRlY2xhcmUob3BlcmF0aW9uLm1vZGVsLCBKc0xhbmcuYXN0QXdhaXQoYHRoaXMuZmluZE9uZV9gLCBKc0xhbmcuYXN0VmFyUmVmKGNvbmRpdGlvblZhck5hbWUpKSlcbiAgICApO1xuXG4gICAgZGVsZXRlIGNvbXBpbGVDb250ZXh0LnZhcmlhYmxlc1tvcGVyYXRpb24ubW9kZWxdLm9uZ29pbmc7XG5cbiAgICBsZXQgbW9kZWxUb3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIG9wZXJhdGlvbi5tb2RlbCk7XG4gICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBlbmRUb3BvSWQsIG1vZGVsVG9wb0lkKTtcbiAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbZW5kVG9wb0lkXSA9IGFzdDtcbiAgICByZXR1cm4gZW5kVG9wb0lkO1xufVxuXG5mdW5jdGlvbiBjb21waWxlRGJPcGVyYXRpb24oaW5kZXgsIG9wZXJhdGlvbiwgY29tcGlsZUNvbnRleHQsIGRlcGVuZGVuY3kpIHtcbiAgICBsZXQgbGFzdFRvcG9JZDtcblxuICAgIHN3aXRjaCAob3BlcmF0aW9uLm9vbFR5cGUpIHtcbiAgICAgICAgY2FzZSAnZmluZE9uZSc6XG4gICAgICAgICAgICBsYXN0VG9wb0lkID0gY29tcGlsZUZpbmRPbmUoaW5kZXgsIG9wZXJhdGlvbiwgY29tcGlsZUNvbnRleHQsIGRlcGVuZGVuY3kpO1xuICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgY2FzZSAnZmluZCc6XG4gICAgICAgICAgICAvL3ByZXBhcmVEYkNvbm5lY3Rpb24oY29tcGlsZUNvbnRleHQpO1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCd0YmknKTtcbiAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgIGNhc2UgJ3VwZGF0ZSc6XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ3RiaScpO1xuICAgICAgICAgICAgLy9wcmVwYXJlRGJDb25uZWN0aW9uKGNvbXBpbGVDb250ZXh0KTtcbiAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgIGNhc2UgJ2NyZWF0ZSc6XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ3RiaScpO1xuICAgICAgICAgICAgLy9wcmVwYXJlRGJDb25uZWN0aW9uKGNvbXBpbGVDb250ZXh0KTtcbiAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgIGNhc2UgJ2RlbGV0ZSc6XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ3RiaScpO1xuICAgICAgICAgICAgLy9wcmVwYXJlRGJDb25uZWN0aW9uKGNvbXBpbGVDb250ZXh0KTtcbiAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgIGNhc2UgJ2phdmFzY3JpcHQnOlxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCd0YmknKTtcbiAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgIGNhc2UgJ2Fzc2lnbm1lbnQnOlxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCd0YmknKTtcbiAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1Vuc3VwcG9ydGVkIG9wZXJhdGlvbiB0eXBlOiAnICsgb3BlcmF0aW9uLnR5cGUpO1xuICAgIH1cblxuICAgIGFkZENvZGVCbG9jayhjb21waWxlQ29udGV4dCwgbGFzdFRvcG9JZCwge1xuICAgICAgICB0eXBlOiBBU1RfQkxLX0lOVEVSRkFDRV9PUEVSQVRJT05cbiAgICB9KTtcblxuICAgIHJldHVybiBsYXN0VG9wb0lkO1xufVxuXG4vKipcbiAqIENvbXBpbGUgZXhjZXB0aW9uYWwgcmV0dXJuIFxuICogQHBhcmFtIHtvYmplY3R9IG9vbE5vZGVcbiAqIEBwYXJhbSB7b2JqZWN0fSBjb21waWxlQ29udGV4dFxuICogQHBhcmFtIHtzdHJpbmd9IFtkZXBlbmRlbmN5XVxuICogQHJldHVybnMge3N0cmluZ30gbGFzdCB0b3BvSWRcbiAqL1xuZnVuY3Rpb24gY29tcGlsZUV4Y2VwdGlvbmFsUmV0dXJuKG9vbE5vZGUsIGNvbXBpbGVDb250ZXh0LCBkZXBlbmRlbmN5KSB7XG4gICAgcHJlOiAoXy5pc1BsYWluT2JqZWN0KG9vbE5vZGUpICYmIG9vbE5vZGUub29sVHlwZSA9PT0gJ1JldHVybkV4cHJlc3Npb24nKTtcblxuICAgIGxldCBlbmRUb3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsICckcmV0dXJuJyksIGxhc3RFeGNlcHRpb25JZCA9IGRlcGVuZGVuY3k7XG5cbiAgICBpZiAoIV8uaXNFbXB0eShvb2xOb2RlLmV4Y2VwdGlvbnMpKSB7XG4gICAgICAgIG9vbE5vZGUuZXhjZXB0aW9ucy5mb3JFYWNoKChpdGVtLCBpKSA9PiB7XG4gICAgICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGl0ZW0pKSB7XG4gICAgICAgICAgICAgICAgaWYgKGl0ZW0ub29sVHlwZSAhPT0gJ0NvbmRpdGlvbmFsU3RhdGVtZW50Jykge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1Vuc3VwcG9ydGVkIGV4Y2VwdGlvbmFsIHR5cGU6ICcgKyBpdGVtLm9vbFR5cGUpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGxldCBleGNlcHRpb25TdGFydElkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBlbmRUb3BvSWQgKyAnOmV4Y2VwdFsnICsgaS50b1N0cmluZygpICsgJ10nKTtcbiAgICAgICAgICAgICAgICBsZXQgZXhjZXB0aW9uRW5kSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIGVuZFRvcG9JZCArICc6ZXhjZXB0WycgKyBpLnRvU3RyaW5nKCkgKyAnXTpkb25lJyk7XG4gICAgICAgICAgICAgICAgaWYgKGxhc3RFeGNlcHRpb25JZCkge1xuICAgICAgICAgICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIGxhc3RFeGNlcHRpb25JZCwgZXhjZXB0aW9uU3RhcnRJZCk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgbGV0IGxhc3RUb3BvSWQgPSBjb21waWxlQ29uZGl0aW9uYWxFeHByZXNzaW9uKGl0ZW0udGVzdCwgY29tcGlsZUNvbnRleHQsIGV4Y2VwdGlvblN0YXJ0SWQpO1xuXG4gICAgICAgICAgICAgICAgbGV0IHRoZW5TdGFydElkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBleGNlcHRpb25TdGFydElkICsgJzp0aGVuJyk7XG4gICAgICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBsYXN0VG9wb0lkLCB0aGVuU3RhcnRJZCk7XG4gICAgICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCB0aGVuU3RhcnRJZCwgZXhjZXB0aW9uRW5kSWQpO1xuXG4gICAgICAgICAgICAgICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW2V4Y2VwdGlvbkVuZElkXSA9IEpzTGFuZy5hc3RJZihcbiAgICAgICAgICAgICAgICAgICAgZ2V0Q29kZVJlcHJlc2VudGF0aW9uT2YobGFzdFRvcG9JZCwgY29tcGlsZUNvbnRleHQpLFxuICAgICAgICAgICAgICAgICAgICBKc0xhbmcuYXN0QmxvY2sodHJhbnNsYXRlUmV0dXJuVGhlbkFzdChcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoZW5TdGFydElkLFxuICAgICAgICAgICAgICAgICAgICAgICAgZXhjZXB0aW9uRW5kSWQsXG4gICAgICAgICAgICAgICAgICAgICAgICBpdGVtLnRoZW4sIGNvbXBpbGVDb250ZXh0KSksXG4gICAgICAgICAgICAgICAgICAgIG51bGwsXG4gICAgICAgICAgICAgICAgICAgIGBSZXR1cm4gb24gZXhjZXB0aW9uICMke2l9YFxuICAgICAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgICAgICBhZGRDb2RlQmxvY2soY29tcGlsZUNvbnRleHQsIGV4Y2VwdGlvbkVuZElkLCB7XG4gICAgICAgICAgICAgICAgICAgIHR5cGU6IEFTVF9CTEtfRVhDRVBUSU9OX0lURU1cbiAgICAgICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgICAgIGxhc3RFeGNlcHRpb25JZCA9IGV4Y2VwdGlvbkVuZElkO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1VuZXhwZWN0ZWQuJyk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgbGFzdEV4Y2VwdGlvbklkLCBlbmRUb3BvSWQpO1xuXG4gICAgbGV0IHJldHVyblN0YXJ0VG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCAnJHJldHVybjp2YWx1ZScpO1xuICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgcmV0dXJuU3RhcnRUb3BvSWQsIGVuZFRvcG9JZCk7XG5cbiAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbZW5kVG9wb0lkXSA9IHRyYW5zbGF0ZVJldHVyblZhbHVlQXN0KHJldHVyblN0YXJ0VG9wb0lkLCBlbmRUb3BvSWQsIG9vbE5vZGUudmFsdWUsIGNvbXBpbGVDb250ZXh0KTtcblxuICAgIGFkZENvZGVCbG9jayhjb21waWxlQ29udGV4dCwgZW5kVG9wb0lkLCB7XG4gICAgICAgIHR5cGU6IEFTVF9CTEtfSU5URVJGQUNFX1JFVFVSTlxuICAgIH0pO1xuICAgIFxuICAgIHJldHVybiBlbmRUb3BvSWQ7XG59XG5cbmZ1bmN0aW9uIGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgbmFtZSkge1xuICAgIGlmIChjb21waWxlQ29udGV4dC50b3BvTm9kZXMuaGFzKG5hbWUpKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgVG9wbyBpZCBcIiR7bmFtZX1cIiBhbHJlYWR5IGNyZWF0ZWQuYCk7XG4gICAgfVxuXG4gICAgYXNzZXJ0OiAhY29tcGlsZUNvbnRleHQudG9wb1NvcnQuaGFzRGVwZW5kZW5jeShuYW1lKSwgJ0FscmVhZHkgaW4gdG9wb1NvcnQhJztcblxuICAgIGNvbXBpbGVDb250ZXh0LnRvcG9Ob2Rlcy5hZGQobmFtZSk7XG5cbiAgICByZXR1cm4gbmFtZTtcbn1cblxuZnVuY3Rpb24gZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBwcmV2aW91c09wLCBjdXJyZW50T3ApIHtcbiAgICBwcmU6IHByZXZpb3VzT3AgIT09IGN1cnJlbnRPcCwgJ1NlbGYgZGVwZW5kaW5nJztcblxuICAgIGNvbXBpbGVDb250ZXh0LmxvZ2dlci5kZWJ1ZyhjdXJyZW50T3AgKyAnIFxceDFiWzMzbWRlcGVuZHMgb25cXHgxYlswbSAnICsgcHJldmlvdXNPcCk7XG5cbiAgICBpZiAoIWNvbXBpbGVDb250ZXh0LnRvcG9Ob2Rlcy5oYXMoY3VycmVudE9wKSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFRvcG8gaWQgXCIke2N1cnJlbnRPcH1cIiBub3QgY3JlYXRlZC5gKTtcbiAgICB9XG5cbiAgICBjb21waWxlQ29udGV4dC50b3BvU29ydC5hZGQocHJldmlvdXNPcCwgY3VycmVudE9wKTtcbn1cblxuZnVuY3Rpb24gYWRkQ29kZUJsb2NrKGNvbXBpbGVDb250ZXh0LCB0b3BvSWQsIGJsb2NrTWV0YSkge1xuICAgIGlmICghKHRvcG9JZCBpbiBjb21waWxlQ29udGV4dC5hc3RNYXApKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgQVNUIG5vdCBmb3VuZCBmb3IgYmxvY2sgd2l0aCB0b3BvSWQ6ICR7dG9wb0lkfWApO1xuICAgIH1cblxuICAgIGNvbXBpbGVDb250ZXh0Lm1hcE9mVG9rZW5Ub01ldGEuc2V0KHRvcG9JZCwgYmxvY2tNZXRhKTtcblxuICAgIGNvbXBpbGVDb250ZXh0LmxvZ2dlci52ZXJib3NlKGBBZGRpbmcgJHtibG9ja01ldGEudHlwZX0gXCIke3RvcG9JZH1cIiBpbnRvIHNvdXJjZSBjb2RlLmApO1xuICAgIC8vY29tcGlsZUNvbnRleHQubG9nZ2VyLmRlYnVnKCdBU1Q6XFxuJyArIEpTT04uc3RyaW5naWZ5KGNvbXBpbGVDb250ZXh0LmFzdE1hcFt0b3BvSWRdLCBudWxsLCAyKSk7XG59XG5cbmZ1bmN0aW9uIGdldENvZGVSZXByZXNlbnRhdGlvbk9mKHRvcG9JZCwgY29tcGlsZUNvbnRleHQpIHtcbiAgICBsZXQgbGFzdFNvdXJjZVR5cGUgPSBjb21waWxlQ29udGV4dC5tYXBPZlRva2VuVG9NZXRhLmdldCh0b3BvSWQpO1xuXG4gICAgaWYgKGxhc3RTb3VyY2VUeXBlICYmIChsYXN0U291cmNlVHlwZS50eXBlID09PSBBU1RfQkxLX1BST0NFU1NPUl9DQUxMIHx8IGxhc3RTb3VyY2VUeXBlLnR5cGUgPT09IEFTVF9CTEtfQUNUSVZBVE9SX0NBTEwpKSB7XG4gICAgICAgIC8vZm9yIG1vZGlmaWVyLCBqdXN0IHVzZSB0aGUgZmluYWwgcmVzdWx0XG4gICAgICAgIHJldHVybiBKc0xhbmcuYXN0VmFyUmVmKGxhc3RTb3VyY2VUeXBlLnRhcmdldCwgdHJ1ZSk7XG4gICAgfVxuXG4gICAgbGV0IGFzdCA9IGNvbXBpbGVDb250ZXh0LmFzdE1hcFt0b3BvSWRdO1xuICAgIGlmIChhc3QudHlwZSA9PT0gJ01lbWJlckV4cHJlc3Npb24nICYmIGFzdC5vYmplY3QubmFtZSA9PT0gJ2xhdGVzdCcpIHtcbiAgICAgICAgcmV0dXJuIEpzTGFuZy5hc3RDb25kaXRpb25hbChcbiAgICAgICAgICAgIEpzTGFuZy5hc3RDYWxsKCdsYXRlc3QuaGFzT3duUHJvcGVydHknLCBbIGFzdC5wcm9wZXJ0eS52YWx1ZSBdKSwgLyoqIHRlc3QgKi9cbiAgICAgICAgICAgIGFzdCwgLyoqIGNvbnNlcXVlbnQgKi9cbiAgICAgICAgICAgIHsgLi4uYXN0LCBvYmplY3Q6IHsgLi4uYXN0Lm9iamVjdCwgbmFtZTogJ2V4aXN0aW5nJyB9IH1cbiAgICAgICAgKTsgICBcbiAgICB9XG5cbiAgICByZXR1cm4gY29tcGlsZUNvbnRleHQuYXN0TWFwW3RvcG9JZF07XG59XG5cbmZ1bmN0aW9uIGNyZWF0ZUNvbXBpbGVDb250ZXh0KG1vZHVsZU5hbWUsIGxvZ2dlciwgc2hhcmVkQ29udGV4dCkge1xuICAgIGxldCBjb21waWxlQ29udGV4dCA9IHtcbiAgICAgICAgbW9kdWxlTmFtZSwgICAgICAgIFxuICAgICAgICBsb2dnZXIsXG4gICAgICAgIHZhcmlhYmxlczoge30sXG4gICAgICAgIHRvcG9Ob2RlczogbmV3IFNldCgpLFxuICAgICAgICB0b3BvU29ydDogbmV3IFRvcG9Tb3J0KCksXG4gICAgICAgIGFzdE1hcDoge30sIC8vIFN0b3JlIHRoZSBBU1QgZm9yIGEgbm9kZVxuICAgICAgICBtYXBPZlRva2VuVG9NZXRhOiBuZXcgTWFwKCksIC8vIFN0b3JlIHRoZSBzb3VyY2UgY29kZSBibG9jayBwb2ludFxuICAgICAgICBtb2RlbFZhcnM6IG5ldyBTZXQoKSxcbiAgICAgICAgbWFwT2ZGdW5jdG9yVG9GaWxlOiAoc2hhcmVkQ29udGV4dCAmJiBzaGFyZWRDb250ZXh0Lm1hcE9mRnVuY3RvclRvRmlsZSkgfHwge30sIC8vIFVzZSB0byByZWNvcmQgaW1wb3J0IGxpbmVzXG4gICAgICAgIG5ld0Z1bmN0b3JGaWxlczogKHNoYXJlZENvbnRleHQgJiYgc2hhcmVkQ29udGV4dC5uZXdGdW5jdG9yRmlsZXMpIHx8IFtdXG4gICAgfTtcblxuICAgIGNvbXBpbGVDb250ZXh0Lm1haW5TdGFydElkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCAnJG1haW4nKTtcblxuICAgIGxvZ2dlci52ZXJib3NlKGBDcmVhdGVkIGNvbXBpbGF0aW9uIGNvbnRleHQgZm9yIFwiJHttb2R1bGVOYW1lfVwiLmApO1xuXG4gICAgcmV0dXJuIGNvbXBpbGVDb250ZXh0O1xufVxuXG5mdW5jdGlvbiBpc1RvcExldmVsQmxvY2sodG9wb0lkKSB7XG4gICAgcmV0dXJuIHRvcG9JZC5pbmRleE9mKCc6YXJnWycpID09PSAtMSAmJiB0b3BvSWQuaW5kZXhPZignJGNhc2VzWycpID09PSAtMSAmJiB0b3BvSWQuaW5kZXhPZignJGV4Y2VwdGlvbnNbJykgPT09IC0xO1xufVxuXG5mdW5jdGlvbiByZXBsYWNlVmFyUmVmU2NvcGUodmFyUmVmLCB0YXJnZXRTY29wZSkge1xuICAgIGlmIChfLmlzUGxhaW5PYmplY3QodmFyUmVmKSkge1xuICAgICAgICBhc3NlcnQ6IHZhclJlZi5vb2xUeXBlID09PSAnT2JqZWN0UmVmZXJlbmNlJztcblxuICAgICAgICByZXR1cm4geyBvb2xUeXBlOiAnT2JqZWN0UmVmZXJlbmNlJywgbmFtZTogcmVwbGFjZVZhclJlZlNjb3BlKHZhclJlZi5uYW1lLCB0YXJnZXRTY29wZSkgfTsgICAgICAgIFxuICAgIH0gXG5cbiAgICBhc3NlcnQ6IHR5cGVvZiB2YXJSZWYgPT09ICdzdHJpbmcnO1xuXG4gICAgbGV0IHBhcnRzID0gdmFyUmVmLnNwbGl0KCcuJyk7XG4gICAgYXNzZXJ0OiBwYXJ0cy5sZW5ndGggPiAxO1xuXG4gICAgcGFydHMuc3BsaWNlKDAsIDEsIHRhcmdldFNjb3BlKTtcbiAgICByZXR1cm4gcGFydHMuam9pbignLicpO1xufVxuXG5tb2R1bGUuZXhwb3J0cyA9IHtcbiAgICBjb21waWxlUGFyYW0sXG4gICAgY29tcGlsZUZpZWxkLFxuICAgIGNvbXBpbGVEYk9wZXJhdGlvbixcbiAgICBjb21waWxlRXhjZXB0aW9uYWxSZXR1cm4sXG4gICAgY29tcGlsZVJldHVybixcbiAgICBjcmVhdGVUb3BvSWQsXG4gICAgY3JlYXRlQ29tcGlsZUNvbnRleHQsXG4gICAgZGVwZW5kc09uLFxuICAgIGFkZENvZGVCbG9jayxcblxuICAgIEFTVF9CTEtfRklFTERfUFJFX1BST0NFU1MsXG4gICAgQVNUX0JMS19QUk9DRVNTT1JfQ0FMTCxcbiAgICBBU1RfQkxLX1ZBTElEQVRPUl9DQUxMLFxuICAgIEFTVF9CTEtfQUNUSVZBVE9SX0NBTEwsXG4gICAgQVNUX0JMS19WSUVXX09QRVJBVElPTixcbiAgICBBU1RfQkxLX1ZJRVdfUkVUVVJOLFxuICAgIEFTVF9CTEtfSU5URVJGQUNFX09QRVJBVElPTixcbiAgICBBU1RfQkxLX0lOVEVSRkFDRV9SRVRVUk4sIFxuICAgIEFTVF9CTEtfRVhDRVBUSU9OX0lURU0sXG5cbiAgICBPT0xfTU9ESUZJRVJfQ09ERV9GTEFHXG59OyJdfQ==