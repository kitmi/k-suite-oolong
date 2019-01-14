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
    addCodeBlock(compileContext, topoId, {
      type: OOL_MODIFIER_CODE_FLAG[functor.oolType],
      target: value.name,
      references: references
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
      fileName = './' + OOL_MODIFIER_PATH[functor.oolType] + '/' + compileContext.targetName + '-' + functionName + '.js';
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

  let [baseName, others] = varOol.name.split('.', 2);
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

      if (compileContext.modelVars && compileContext.modelVars.has(refBase)) {
        dependency = refBase;
      } else if (refBase === 'latest' && rest.length > 0) {
        let refFieldName = rest.pop();

        if (refFieldName !== startTopoId) {
          dependency = refFieldName + ':ready';
        }
      } else if (_.isEmpty(rest)) {
        dependency = refBase + ':ready';
      } else {
        throw new Error('Unrecognized object reference: ' + JSON.stringify(value));
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

    if (then.oolType === 'ReturnExpression') {
      return translateReturnValueAst(startId, endId, then.value, compileContext);
    }
  }

  if (_.isArray(then) || _.isPlainObject(then)) {
    let valueEndId = compileConcreteValueExpression(startId, then, compileContext);
    then = compileContext.astMap[valueEndId];
  }

  if (!assignTo) {
    return JsLang.astReturn(then);
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
    }
  }

  ast.push(JsLang.astVarDeclare(operation.model, JsLang.astAwait(`this.findOne_`, JsLang.astVarRef(conditionVarName))));
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
        compileContext.astMap[exceptionEndId] = JsLang.astIf(getCodeRepresentationOf(lastTopoId, compileContext), JsLang.astBlock(translateThenAst(thenStartId, exceptionEndId, item.then, compileContext)), null, `Return on exception #${i}`);
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

  if (name === '') {
    throw new Error();
  }

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

function createCompileContext(targetName, logger, sharedContext) {
  let compileContext = {
    targetName,
    logger,
    topoNodes: new Set(),
    topoSort: new TopoSort(),
    astMap: {},
    mapOfTokenToMeta: new Map(),
    modelVars: new Set(),
    mapOfFunctorToFile: sharedContext && sharedContext.mapOfFunctorToFile || {},
    newFunctorFiles: sharedContext && sharedContext.newFunctorFiles || []
  };
  compileContext.mainStartId = createTopoId(compileContext, '$main');
  logger.verbose(`Created compilation context for "${targetName}".`);
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9tb2RlbGVyL3V0aWwvb29sVG9Bc3QuanMiXSwibmFtZXMiOlsiXyIsInJlcXVpcmUiLCJUb3BvU29ydCIsIkpzTGFuZyIsIk9vbFR5cGVzIiwiaXNEb3RTZXBhcmF0ZU5hbWUiLCJleHRyYWN0RG90U2VwYXJhdGVOYW1lIiwiZXh0cmFjdFJlZmVyZW5jZUJhc2VOYW1lIiwiT29sb25nVmFsaWRhdG9ycyIsIk9vbG9uZ1Byb2Nlc3NvcnMiLCJPb2xvbmdBY3RpdmF0b3JzIiwiVHlwZXMiLCJkZWZhdWx0RXJyb3IiLCJBU1RfQkxLX0ZJRUxEX1BSRV9QUk9DRVNTIiwiQVNUX0JMS19QQVJBTV9TQU5JVElaRSIsIkFTVF9CTEtfUFJPQ0VTU09SX0NBTEwiLCJBU1RfQkxLX1ZBTElEQVRPUl9DQUxMIiwiQVNUX0JMS19BQ1RJVkFUT1JfQ0FMTCIsIkFTVF9CTEtfVklFV19PUEVSQVRJT04iLCJBU1RfQkxLX1ZJRVdfUkVUVVJOIiwiQVNUX0JMS19JTlRFUkZBQ0VfT1BFUkFUSU9OIiwiQVNUX0JMS19JTlRFUkZBQ0VfUkVUVVJOIiwiQVNUX0JMS19FWENFUFRJT05fSVRFTSIsIk9PTF9NT0RJRklFUl9DT0RFX0ZMQUciLCJNb2RpZmllciIsIlZBTElEQVRPUiIsIlBST0NFU1NPUiIsIkFDVElWQVRPUiIsIk9PTF9NT0RJRklFUl9PUCIsIk9PTF9NT0RJRklFUl9QQVRIIiwiT09MX01PRElGSUVSX0JVSUxUSU4iLCJjb21waWxlQ29uZGl0aW9uYWxFeHByZXNzaW9uIiwidGVzdCIsImNvbXBpbGVDb250ZXh0Iiwic3RhcnRUb3BvSWQiLCJpc1BsYWluT2JqZWN0Iiwib29sVHlwZSIsImVuZFRvcG9JZCIsImNyZWF0ZVRvcG9JZCIsIm9wZXJhbmRUb3BvSWQiLCJkZXBlbmRzT24iLCJsYXN0T3BlcmFuZFRvcG9JZCIsImNvbXBpbGVDb25jcmV0ZVZhbHVlRXhwcmVzc2lvbiIsImNhbGxlciIsImFzdEFyZ3VtZW50IiwiZ2V0Q29kZVJlcHJlc2VudGF0aW9uT2YiLCJyZXRUb3BvSWQiLCJjb21waWxlQWRIb2NWYWxpZGF0b3IiLCJjYWxsZWUiLCJvcCIsIm9wZXJhdG9yIiwiRXJyb3IiLCJsZWZ0VG9wb0lkIiwicmlnaHRUb3BvSWQiLCJsYXN0TGVmdElkIiwibGVmdCIsImxhc3RSaWdodElkIiwicmlnaHQiLCJhc3RNYXAiLCJhc3RCaW5FeHAiLCJhcmd1bWVudCIsImFzdE5vdCIsImFzdENhbGwiLCJ2YWx1ZVN0YXJ0VG9wb0lkIiwiYXN0VmFsdWUiLCJ0b3BvSWQiLCJ2YWx1ZSIsImZ1bmN0b3IiLCJjYWxsQXJncyIsImFyZ3MiLCJ0cmFuc2xhdGVBcmdzIiwiYXJnMCIsIm5hbWUiLCJjb25jYXQiLCJjb21waWxlTW9kaWZpZXIiLCJkZWNsYXJlUGFyYW1zIiwidHJhbnNsYXRlRnVuY3Rpb25QYXJhbXMiLCJpc0VtcHR5IiwiZnVuY3RvcklkIiwidHJhbnNsYXRlTW9kaWZpZXIiLCJyZWZlcmVuY2VzIiwiZXh0cmFjdFJlZmVyZW5jZWRGaWVsZHMiLCJmaW5kIiwicmVmIiwiaXNUb3BMZXZlbEJsb2NrIiwic3RhcnRzV2l0aCIsImFzdENvbmRpdGlvbmFsIiwicmVwbGFjZVZhclJlZlNjb3BlIiwiYWRkQ29kZUJsb2NrIiwidHlwZSIsInRhcmdldCIsIm9vbEFyZ3MiLCJjYXN0QXJyYXkiLCJyZWZzIiwiZm9yRWFjaCIsImEiLCJyZXN1bHQiLCJjaGVja1JlZmVyZW5jZVRvRmllbGQiLCJwdXNoIiwib2JqIiwidW5kZWZpbmVkIiwiYWRkTW9kaWZpZXJUb01hcCIsImZ1bmN0b3JUeXBlIiwiZnVuY3RvckpzRmlsZSIsIm1hcE9mRnVuY3RvclRvRmlsZSIsImZ1bmN0aW9uTmFtZSIsImZpbGVOYW1lIiwibmFtZXMiLCJsZW5ndGgiLCJyZWZFbnRpdHlOYW1lIiwidXBwZXJGaXJzdCIsImJ1aWx0aW5zIiwidGFyZ2V0TmFtZSIsIm5ld0Z1bmN0b3JGaWxlcyIsImNvbXBpbGVQaXBlZFZhbHVlIiwidmFyT29sIiwibGFzdFRvcG9JZCIsIm1vZGlmaWVycyIsIm1vZGlmaWVyIiwibW9kaWZpZXJTdGFydFRvcG9JZCIsImNvbXBpbGVWYXJpYWJsZVJlZmVyZW5jZSIsImJhc2VOYW1lIiwib3RoZXJzIiwic3BsaXQiLCJTZXQiLCJ0cmFuc2xhdGVGdW5jdGlvblBhcmFtIiwiYXJnIiwiaSIsInBvcCIsInRvU3RyaW5nIiwibWFwIiwiY291bnQiLCJoYXMiLCJhZGQiLCJyZWZCYXNlIiwicmVzdCIsImRlcGVuZGVuY3kiLCJtb2RlbFZhcnMiLCJyZWZGaWVsZE5hbWUiLCJKU09OIiwic3RyaW5naWZ5IiwibWFwVmFsdWVzIiwidmFsdWVPZkVsZW1lbnQiLCJrZXkiLCJzaWQiLCJlaWQiLCJBcnJheSIsImlzQXJyYXkiLCJpbmRleCIsImVhY2giLCJhcmdUb3BvSWQiLCJjb21waWxlUGFyYW0iLCJwYXJhbSIsInR5cGVPYmplY3QiLCJzYW5pdGl6ZXJOYW1lIiwidG9VcHBlckNhc2UiLCJ2YXJSZWYiLCJhc3RWYXJSZWYiLCJjYWxsQXN0IiwiYXN0QXJyYXlBY2Nlc3MiLCJwcmVwYXJlVG9wb0lkIiwiYXN0QXNzaWduIiwibWFpblN0YXJ0SWQiLCJ3cmFwUGFyYW1SZWZlcmVuY2UiLCJyZWFkeVRvcG9JZCIsImNvbXBpbGVGaWVsZCIsInBhcmFtTmFtZSIsImNvbnRleHROYW1lIiwiT2JqZWN0IiwiYXNzaWduIiwidHJhbnNsYXRlVGhlbkFzdCIsInN0YXJ0SWQiLCJlbmRJZCIsInRoZW4iLCJhc3NpZ25UbyIsImFzdFRocm93IiwiZXJyb3JUeXBlIiwibWVzc2FnZSIsInRyYW5zbGF0ZVJldHVyblZhbHVlQXN0IiwidmFsdWVFbmRJZCIsImFzdFJldHVybiIsInZhbHVlVG9wb0lkIiwiY29tcGlsZVJldHVybiIsImNvbXBpbGVGaW5kT25lIiwib3BlcmF0aW9uIiwiY29uZGl0aW9uVmFyTmFtZSIsImFzdCIsImFzdFZhckRlY2xhcmUiLCJjb25kaXRpb24iLCJ0b3BvSWRQcmVmaXgiLCJsYXN0U3RhdGVtZW50IiwiZWxzZSIsImVsc2VTdGFydCIsImVsc2VFbmQiLCJpdGVtcyIsInJldmVyc2UiLCJpdGVtIiwiY2FzZVByZWZpeCIsImNhc2VUb3BvSWQiLCJjYXNlUmVzdWx0VmFyTmFtZSIsImFzdENhc2VUdGVtIiwibW9kZWwiLCJpZlN0YXJ0IiwiaWZFbmQiLCJhc3RJZiIsImFzdEJsb2NrIiwiYXN0QXdhaXQiLCJtb2RlbFRvcG9JZCIsImNvbXBpbGVEYk9wZXJhdGlvbiIsImNvbXBpbGVFeGNlcHRpb25hbFJldHVybiIsIm9vbE5vZGUiLCJsYXN0RXhjZXB0aW9uSWQiLCJleGNlcHRpb25zIiwiZXhjZXB0aW9uU3RhcnRJZCIsImV4Y2VwdGlvbkVuZElkIiwidGhlblN0YXJ0SWQiLCJyZXR1cm5TdGFydFRvcG9JZCIsInRvcG9Ob2RlcyIsInRvcG9Tb3J0IiwiaGFzRGVwZW5kZW5jeSIsInByZXZpb3VzT3AiLCJjdXJyZW50T3AiLCJsb2dnZXIiLCJkZWJ1ZyIsImJsb2NrTWV0YSIsIm1hcE9mVG9rZW5Ub01ldGEiLCJzZXQiLCJ2ZXJib3NlIiwibGFzdFNvdXJjZVR5cGUiLCJnZXQiLCJvYmplY3QiLCJwcm9wZXJ0eSIsImNyZWF0ZUNvbXBpbGVDb250ZXh0Iiwic2hhcmVkQ29udGV4dCIsIk1hcCIsImluZGV4T2YiLCJ0YXJnZXRTY29wZSIsInBhcnRzIiwic3BsaWNlIiwiam9pbiIsIm1vZHVsZSIsImV4cG9ydHMiXSwibWFwcGluZ3MiOiJBQUFBOzs7O0FBT0EsTUFBTTtBQUFFQSxFQUFBQTtBQUFGLElBQVFDLE9BQU8sQ0FBQyxVQUFELENBQXJCOztBQUNBLE1BQU07QUFBRUMsRUFBQUE7QUFBRixJQUFlRCxPQUFPLENBQUMscUJBQUQsQ0FBNUI7O0FBRUEsTUFBTUUsTUFBTSxHQUFHRixPQUFPLENBQUMsVUFBRCxDQUF0Qjs7QUFDQSxNQUFNRyxRQUFRLEdBQUdILE9BQU8sQ0FBQyxxQkFBRCxDQUF4Qjs7QUFDQSxNQUFNO0FBQUVJLEVBQUFBLGlCQUFGO0FBQXFCQyxFQUFBQSxzQkFBckI7QUFBNkNDLEVBQUFBO0FBQTdDLElBQTBF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akYsTUFBTSxDQUFDakMsS0FBUCxDQUFhLEdBQWIsQ0FBWjs7QUFUNkMsUUFVckNrSCxLQUFLLENBQUNqSSxNQUFOLEdBQWUsQ0FWc0I7QUFBQTtBQUFBOztBQVk3Q2lJLEVBQUFBLEtBQUssQ0FBQ0MsTUFBTixDQUFhLENBQWIsRUFBZ0IsQ0FBaEIsRUFBbUJGLFdBQW5CO0FBQ0EsU0FBT0MsS0FBSyxDQUFDRSxJQUFOLENBQVcsR0FBWCxDQUFQO0FBQ0g7O0FBRURDLE1BQU0sQ0FBQ0MsT0FBUCxHQUFpQjtBQUNiMUYsRUFBQUEsWUFEYTtBQUViYyxFQUFBQSxZQUZhO0FBR2IyQyxFQUFBQSxrQkFIYTtBQUliQyxFQUFBQSx3QkFKYTtBQUtiM0IsRUFBQUEsYUFMYTtBQU1iaEosRUFBQUEsWUFOYTtBQU9ia00sRUFBQUEsb0JBUGE7QUFRYmhNLEVBQUFBLFNBUmE7QUFTYmdELEVBQUFBLFlBVGE7QUFXYjNFLEVBQUFBLHlCQVhhO0FBWWJFLEVBQUFBLHNCQVphO0FBYWJDLEVBQUFBLHNCQWJhO0FBY2JDLEVBQUFBLHNCQWRhO0FBZWJDLEVBQUFBLHNCQWZhO0FBZ0JiQyxFQUFBQSxtQkFoQmE7QUFpQmJDLEVBQUFBLDJCQWpCYTtBQWtCYkMsRUFBQUEsd0JBbEJhO0FBbUJiQyxFQUFBQSxzQkFuQmE7QUFxQmJDLEVBQUFBO0FBckJhLENBQWpCIiwic291cmNlc0NvbnRlbnQiOlsiXCJ1c2Ugc3RyaWN0XCI7XG5cbi8qKlxuICogQG1vZHVsZVxuICogQGlnbm9yZVxuICovXG5cbmNvbnN0IHsgXyB9ID0gcmVxdWlyZSgncmstdXRpbHMnKTtcbmNvbnN0IHsgVG9wb1NvcnQgfSA9IHJlcXVpcmUoJ0BrLXN1aXRlL2FsZ29yaXRobXMnKTtcblxuY29uc3QgSnNMYW5nID0gcmVxdWlyZSgnLi9hc3QuanMnKTtcbmNvbnN0IE9vbFR5cGVzID0gcmVxdWlyZSgnLi4vLi4vbGFuZy9Pb2xUeXBlcycpO1xuY29uc3QgeyBpc0RvdFNlcGFyYXRlTmFtZSwgZXh0cmFjdERvdFNlcGFyYXRlTmFtZSwgZXh0cmFjdFJlZmVyZW5jZUJhc2VOYW1lIH0gPSByZXF1aXJlKCcuLi8uLi9sYW5nL09vbFV0aWxzJyk7XG5jb25zdCBPb2xvbmdWYWxpZGF0b3JzID0gcmVxdWlyZSgnLi4vLi4vcnVudGltZS9WYWxpZGF0b3JzJyk7XG5jb25zdCBPb2xvbmdQcm9jZXNzb3JzID0gcmVxdWlyZSgnLi4vLi4vcnVudGltZS9Qcm9jZXNzb3JzJyk7XG5jb25zdCBPb2xvbmdBY3RpdmF0b3JzID0gcmVxdWlyZSgnLi4vLi4vcnVudGltZS9BY3RpdmF0b3JzJyk7XG5jb25zdCBUeXBlcyA9IHJlcXVpcmUoJy4uLy4uL3J1bnRpbWUvdHlwZXMnKTtcblxuY29uc3QgZGVmYXVsdEVycm9yID0gJ0ludmFsaWRSZXF1ZXN0JztcblxuY29uc3QgQVNUX0JMS19GSUVMRF9QUkVfUFJPQ0VTUyA9ICdGaWVsZFByZVByb2Nlc3MnO1xuY29uc3QgQVNUX0JMS19QQVJBTV9TQU5JVElaRSA9ICdQYXJhbWV0ZXJTYW5pdGl6ZSc7XG5jb25zdCBBU1RfQkxLX1BST0NFU1NPUl9DQUxMID0gJ1Byb2Nlc3NvckNhbGwnO1xuY29uc3QgQVNUX0JMS19WQUxJREFUT1JfQ0FMTCA9ICdWYWxpZGF0b3JDYWxsJztcbmNvbnN0IEFTVF9CTEtfQUNUSVZBVE9SX0NBTEwgPSAnQWN0aXZhdG9yQ2FsbCc7XG5jb25zdCBBU1RfQkxLX1ZJRVdfT1BFUkFUSU9OID0gJ1ZpZXdPcGVyYXRpb24nO1xuY29uc3QgQVNUX0JMS19WSUVXX1JFVFVSTiA9ICdWaWV3UmV0dXJuJztcbmNvbnN0IEFTVF9CTEtfSU5URVJGQUNFX09QRVJBVElPTiA9ICdJbnRlcmZhY2VPcGVyYXRpb24nO1xuY29uc3QgQVNUX0JMS19JTlRFUkZBQ0VfUkVUVVJOID0gJ0ludGVyZmFjZVJldHVybic7XG5jb25zdCBBU1RfQkxLX0VYQ0VQVElPTl9JVEVNID0gJ0V4Y2VwdGlvbkl0ZW0nO1xuXG5jb25zdCBPT0xfTU9ESUZJRVJfQ09ERV9GTEFHID0ge1xuICAgIFtPb2xUeXBlcy5Nb2RpZmllci5WQUxJREFUT1JdOiBBU1RfQkxLX1ZBTElEQVRPUl9DQUxMLFxuICAgIFtPb2xUeXBlcy5Nb2RpZmllci5QUk9DRVNTT1JdOiBBU1RfQkxLX1BST0NFU1NPUl9DQUxMLFxuICAgIFtPb2xUeXBlcy5Nb2RpZmllci5BQ1RJVkFUT1JdOiBBU1RfQkxLX0FDVElWQVRPUl9DQUxMXG59O1xuXG5jb25zdCBPT0xfTU9ESUZJRVJfT1AgPSB7XG4gICAgW09vbFR5cGVzLk1vZGlmaWVyLlZBTElEQVRPUl06ICd+JyxcbiAgICBbT29sVHlwZXMuTW9kaWZpZXIuUFJPQ0VTU09SXTogJ3w+JyxcbiAgICBbT29sVHlwZXMuTW9kaWZpZXIuQUNUSVZBVE9SXTogJz0nIFxufTtcblxuY29uc3QgT09MX01PRElGSUVSX1BBVEggPSB7XG4gICAgW09vbFR5cGVzLk1vZGlmaWVyLlZBTElEQVRPUl06ICd2YWxpZGF0b3JzJyxcbiAgICBbT29sVHlwZXMuTW9kaWZpZXIuUFJPQ0VTU09SXTogJ3Byb2Nlc3NvcnMnLFxuICAgIFtPb2xUeXBlcy5Nb2RpZmllci5BQ1RJVkFUT1JdOiAnYWN0aXZhdG9ycycgXG59O1xuXG5jb25zdCBPT0xfTU9ESUZJRVJfQlVJTFRJTiA9IHtcbiAgICBbT29sVHlwZXMuTW9kaWZpZXIuVkFMSURBVE9SXTogT29sb25nVmFsaWRhdG9ycyxcbiAgICBbT29sVHlwZXMuTW9kaWZpZXIuUFJPQ0VTU09SXTogT29sb25nUHJvY2Vzc29ycyxcbiAgICBbT29sVHlwZXMuTW9kaWZpZXIuQUNUSVZBVE9SXTogT29sb25nQWN0aXZhdG9ycyBcbn07XG5cbi8qKlxuICogQ29tcGlsZSBhIGNvbmRpdGlvbmFsIGV4cHJlc3Npb25cbiAqIEBwYXJhbSB7b2JqZWN0fSB0ZXN0XG4gKiBAcGFyYW0ge29iamVjdH0gY29tcGlsZUNvbnRleHRcbiAqIEBwcm9wZXJ0eSB7c3RyaW5nfSBjb21waWxlQ29udGV4dC50YXJnZXROYW1lXG4gKiBAcHJvcGVydHkge1RvcG9Tb3J0fSBjb21waWxlQ29udGV4dC50b3BvU29ydFxuICogQHByb3BlcnR5IHtvYmplY3R9IGNvbXBpbGVDb250ZXh0LmFzdE1hcCAtIFRvcG8gSWQgdG8gYXN0IG1hcFxuICogQHBhcmFtIHtzdHJpbmd9IHN0YXJ0VG9wb0lkXG4gKiBAcmV0dXJucyB7c3RyaW5nfSBUb3BvIElkXG4gKi9cbmZ1bmN0aW9uIGNvbXBpbGVDb25kaXRpb25hbEV4cHJlc3Npb24odGVzdCwgY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkKSB7XG4gICAgaWYgKF8uaXNQbGFpbk9iamVjdCh0ZXN0KSkgeyAgICAgICAgXG4gICAgICAgIGlmICh0ZXN0Lm9vbFR5cGUgPT09ICdWYWxpZGF0ZUV4cHJlc3Npb24nKSB7XG4gICAgICAgICAgICBsZXQgZW5kVG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCArICckdmFsaU9wOmRvbmUnKTtcbiAgICAgICAgICAgIGxldCBvcGVyYW5kVG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCArICckdmFsaU9wJyk7XG5cbiAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgc3RhcnRUb3BvSWQsIG9wZXJhbmRUb3BvSWQpO1xuXG4gICAgICAgICAgICBsZXQgbGFzdE9wZXJhbmRUb3BvSWQgPSBjb21waWxlQ29uY3JldGVWYWx1ZUV4cHJlc3Npb24ob3BlcmFuZFRvcG9JZCwgdGVzdC5jYWxsZXIsIGNvbXBpbGVDb250ZXh0KTtcbiAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgbGFzdE9wZXJhbmRUb3BvSWQsIGVuZFRvcG9JZCk7XG5cbiAgICAgICAgICAgIGxldCBhc3RBcmd1bWVudCA9IGdldENvZGVSZXByZXNlbnRhdGlvbk9mKGxhc3RPcGVyYW5kVG9wb0lkLCBjb21waWxlQ29udGV4dCk7XG5cbiAgICAgICAgICAgIGxldCByZXRUb3BvSWQgPSBjb21waWxlQWRIb2NWYWxpZGF0b3IoZW5kVG9wb0lkLCBhc3RBcmd1bWVudCwgdGVzdC5jYWxsZWUsIGNvbXBpbGVDb250ZXh0KTtcblxuICAgICAgICAgICAgYXNzZXJ0OiByZXRUb3BvSWQgPT09IGVuZFRvcG9JZDtcblxuICAgICAgICAgICAgLypcbiAgICAgICAgICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtlbmRUb3BvSWRdID0gSnNMYW5nLmFzdENhbGwoJ18uaXNFbXB0eScsIGFzdEFyZ3VtZW50KTtcblxuICAgICAgICAgICAgc3dpdGNoICh0ZXN0Lm9wZXJhdG9yKSB7XG4gICAgICAgICAgICAgICAgY2FzZSAnZXhpc3RzJzpcbiAgICAgICAgICAgICAgICAgICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW2VuZFRvcG9JZF0gPSBKc0xhbmcuYXN0Tm90KEpzTGFuZy5hc3RDYWxsKCdfLmlzRW1wdHknLCBhc3RBcmd1bWVudCkpO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgICAgIGNhc2UgJ2lzLW5vdC1udWxsJzpcbiAgICAgICAgICAgICAgICAgICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW2VuZFRvcG9JZF0gPSBKc0xhbmcuYXN0Tm90KEpzTGFuZy5hc3RDYWxsKCdfLmlzTmlsJywgYXN0QXJndW1lbnQpKTtcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgICAgICBjYXNlICdub3QtZXhpc3RzJzpcbiAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgY2FzZSAnaXMtbnVsbCc6XG4gICAgICAgICAgICAgICAgICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtlbmRUb3BvSWRdID0gSnNMYW5nLmFzdENhbGwoJ18uaXNOaWwnLCBhc3RBcmd1bWVudCk7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgY2FzZSAnbm90JzpcbiAgICAgICAgICAgICAgICAgICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW2VuZFRvcG9JZF0gPSBKc0xhbmcuYXN0Tm90KGFzdEFyZ3VtZW50KTtcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1Vuc3VwcG9ydGVkIHRlc3Qgb3BlcmF0b3I6ICcgKyB0ZXN0Lm9wZXJhdG9yKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgICovXG5cbiAgICAgICAgICAgIHJldHVybiBlbmRUb3BvSWQ7XG5cbiAgICAgICAgfSBlbHNlIGlmICh0ZXN0Lm9vbFR5cGUgPT09ICdMb2dpY2FsRXhwcmVzc2lvbicpIHtcbiAgICAgICAgICAgIGxldCBlbmRUb3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkICsgJyRsb3BPcDpkb25lJyk7XG5cbiAgICAgICAgICAgIGxldCBvcDtcblxuICAgICAgICAgICAgc3dpdGNoICh0ZXN0Lm9wZXJhdG9yKSB7XG4gICAgICAgICAgICAgICAgY2FzZSAnYW5kJzpcbiAgICAgICAgICAgICAgICAgICAgb3AgPSAnJiYnO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgICAgIGNhc2UgJ29yJzpcbiAgICAgICAgICAgICAgICAgICAgb3AgPSAnfHwnO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5zdXBwb3J0ZWQgdGVzdCBvcGVyYXRvcjogJyArIHRlc3Qub3BlcmF0b3IpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgbGVmdFRvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgc3RhcnRUb3BvSWQgKyAnJGxvcE9wOmxlZnQnKTtcbiAgICAgICAgICAgIGxldCByaWdodFRvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgc3RhcnRUb3BvSWQgKyAnJGxvcE9wOnJpZ2h0Jyk7XG5cbiAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgc3RhcnRUb3BvSWQsIGxlZnRUb3BvSWQpO1xuICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCwgcmlnaHRUb3BvSWQpO1xuXG4gICAgICAgICAgICBsZXQgbGFzdExlZnRJZCA9IGNvbXBpbGVDb25kaXRpb25hbEV4cHJlc3Npb24odGVzdC5sZWZ0LCBjb21waWxlQ29udGV4dCwgbGVmdFRvcG9JZCk7XG4gICAgICAgICAgICBsZXQgbGFzdFJpZ2h0SWQgPSBjb21waWxlQ29uZGl0aW9uYWxFeHByZXNzaW9uKHRlc3QucmlnaHQsIGNvbXBpbGVDb250ZXh0LCByaWdodFRvcG9JZCk7XG5cbiAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgbGFzdExlZnRJZCwgZW5kVG9wb0lkKTtcbiAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgbGFzdFJpZ2h0SWQsIGVuZFRvcG9JZCk7XG5cbiAgICAgICAgICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtlbmRUb3BvSWRdID0gSnNMYW5nLmFzdEJpbkV4cChcbiAgICAgICAgICAgICAgICBnZXRDb2RlUmVwcmVzZW50YXRpb25PZihsYXN0TGVmdElkLCBjb21waWxlQ29udGV4dCksXG4gICAgICAgICAgICAgICAgb3AsXG4gICAgICAgICAgICAgICAgZ2V0Q29kZVJlcHJlc2VudGF0aW9uT2YobGFzdFJpZ2h0SWQsIGNvbXBpbGVDb250ZXh0KVxuICAgICAgICAgICAgKTsgXG5cbiAgICAgICAgICAgIHJldHVybiBlbmRUb3BvSWQ7XG5cbiAgICAgICAgfSBlbHNlIGlmICh0ZXN0Lm9vbFR5cGUgPT09ICdCaW5hcnlFeHByZXNzaW9uJykge1xuICAgICAgICAgICAgbGV0IGVuZFRvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgc3RhcnRUb3BvSWQgKyAnJGJpbk9wOmRvbmUnKTtcblxuICAgICAgICAgICAgbGV0IG9wO1xuXG4gICAgICAgICAgICBzd2l0Y2ggKHRlc3Qub3BlcmF0b3IpIHtcbiAgICAgICAgICAgICAgICBjYXNlICc+JzpcbiAgICAgICAgICAgICAgICBjYXNlICc8JzpcbiAgICAgICAgICAgICAgICBjYXNlICc+PSc6XG4gICAgICAgICAgICAgICAgY2FzZSAnPD0nOlxuICAgICAgICAgICAgICAgIGNhc2UgJ2luJzpcbiAgICAgICAgICAgICAgICAgICAgb3AgPSB0ZXN0Lm9wZXJhdG9yO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgICAgIGNhc2UgJz09JzpcbiAgICAgICAgICAgICAgICAgICAgb3AgPSAnPT09JztcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgICAgICBjYXNlICchPSc6XG4gICAgICAgICAgICAgICAgICAgIG9wID0gJyE9PSc7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbnN1cHBvcnRlZCB0ZXN0IG9wZXJhdG9yOiAnICsgdGVzdC5vcGVyYXRvcik7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCBsZWZ0VG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCArICckYmluT3A6bGVmdCcpO1xuICAgICAgICAgICAgbGV0IHJpZ2h0VG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCArICckYmluT3A6cmlnaHQnKTtcblxuICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCwgbGVmdFRvcG9JZCk7XG4gICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkLCByaWdodFRvcG9JZCk7XG5cbiAgICAgICAgICAgIGxldCBsYXN0TGVmdElkID0gY29tcGlsZUNvbmNyZXRlVmFsdWVFeHByZXNzaW9uKGxlZnRUb3BvSWQsIHRlc3QubGVmdCwgY29tcGlsZUNvbnRleHQpO1xuICAgICAgICAgICAgbGV0IGxhc3RSaWdodElkID0gY29tcGlsZUNvbmNyZXRlVmFsdWVFeHByZXNzaW9uKHJpZ2h0VG9wb0lkLCB0ZXN0LnJpZ2h0LCBjb21waWxlQ29udGV4dCk7XG5cbiAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgbGFzdExlZnRJZCwgZW5kVG9wb0lkKTtcbiAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgbGFzdFJpZ2h0SWQsIGVuZFRvcG9JZCk7XG5cbiAgICAgICAgICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtlbmRUb3BvSWRdID0gSnNMYW5nLmFzdEJpbkV4cChcbiAgICAgICAgICAgICAgICBnZXRDb2RlUmVwcmVzZW50YXRpb25PZihsYXN0TGVmdElkLCBjb21waWxlQ29udGV4dCksXG4gICAgICAgICAgICAgICAgb3AsXG4gICAgICAgICAgICAgICAgZ2V0Q29kZVJlcHJlc2VudGF0aW9uT2YobGFzdFJpZ2h0SWQsIGNvbXBpbGVDb250ZXh0KVxuICAgICAgICAgICAgKTsgXG5cbiAgICAgICAgICAgIHJldHVybiBlbmRUb3BvSWQ7XG5cbiAgICAgICAgfSBlbHNlIGlmICh0ZXN0Lm9vbFR5cGUgPT09ICdVbmFyeUV4cHJlc3Npb24nKSB7XG4gICAgICAgICAgICBsZXQgZW5kVG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCArICckdW5hT3A6ZG9uZScpO1xuICAgICAgICAgICAgbGV0IG9wZXJhbmRUb3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkICsgJyR1bmFPcCcpO1xuXG4gICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkLCBvcGVyYW5kVG9wb0lkKTtcblxuICAgICAgICAgICAgbGV0IGxhc3RPcGVyYW5kVG9wb0lkID0gdGVzdC5vcGVyYXRvciA9PT0gJ25vdCcgPyBjb21waWxlQ29uY3JldGVWYWx1ZUV4cHJlc3Npb24ob3BlcmFuZFRvcG9JZCwgdGVzdC5hcmd1bWVudCwgY29tcGlsZUNvbnRleHQpIDogY29tcGlsZUNvbmRpdGlvbmFsRXhwcmVzc2lvbih0ZXN0LmFyZ3VtZW50LCBjb21waWxlQ29udGV4dCwgb3BlcmFuZFRvcG9JZCk7XG4gICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIGxhc3RPcGVyYW5kVG9wb0lkLCBlbmRUb3BvSWQpO1xuXG4gICAgICAgICAgICBsZXQgYXN0QXJndW1lbnQgPSBnZXRDb2RlUmVwcmVzZW50YXRpb25PZihsYXN0T3BlcmFuZFRvcG9JZCwgY29tcGlsZUNvbnRleHQpO1xuXG4gICAgICAgICAgICBzd2l0Y2ggKHRlc3Qub3BlcmF0b3IpIHtcbiAgICAgICAgICAgICAgICBjYXNlICdleGlzdHMnOlxuICAgICAgICAgICAgICAgICAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbZW5kVG9wb0lkXSA9IEpzTGFuZy5hc3ROb3QoSnNMYW5nLmFzdENhbGwoJ18uaXNFbXB0eScsIGFzdEFyZ3VtZW50KSk7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgY2FzZSAnaXMtbm90LW51bGwnOlxuICAgICAgICAgICAgICAgICAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbZW5kVG9wb0lkXSA9IEpzTGFuZy5hc3ROb3QoSnNMYW5nLmFzdENhbGwoJ18uaXNOaWwnLCBhc3RBcmd1bWVudCkpO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgICAgIGNhc2UgJ25vdC1leGlzdHMnOlxuICAgICAgICAgICAgICAgICAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbZW5kVG9wb0lkXSA9IEpzTGFuZy5hc3RDYWxsKCdfLmlzRW1wdHknLCBhc3RBcmd1bWVudCk7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgY2FzZSAnaXMtbnVsbCc6XG4gICAgICAgICAgICAgICAgICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtlbmRUb3BvSWRdID0gSnNMYW5nLmFzdENhbGwoJ18uaXNOaWwnLCBhc3RBcmd1bWVudCk7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgY2FzZSAnbm90JzpcbiAgICAgICAgICAgICAgICAgICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW2VuZFRvcG9JZF0gPSBKc0xhbmcuYXN0Tm90KGFzdEFyZ3VtZW50KTtcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1Vuc3VwcG9ydGVkIHRlc3Qgb3BlcmF0b3I6ICcgKyB0ZXN0Lm9wZXJhdG9yKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIGVuZFRvcG9JZDtcblxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgbGV0IHZhbHVlU3RhcnRUb3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkICsgJyR2YWx1ZScpO1xuICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCwgdmFsdWVTdGFydFRvcG9JZCk7XG4gICAgICAgICAgICByZXR1cm4gY29tcGlsZUNvbmNyZXRlVmFsdWVFeHByZXNzaW9uKHZhbHVlU3RhcnRUb3BvSWQsIHRlc3QsIGNvbXBpbGVDb250ZXh0KTtcbiAgICAgICAgfSBcbiAgICB9XG5cbiAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbc3RhcnRUb3BvSWRdID0gSnNMYW5nLmFzdFZhbHVlKHRlc3QpO1xuICAgIHJldHVybiBzdGFydFRvcG9JZDtcbn1cblxuLyoqXG4gKiBDb21waWxlIGEgdmFsaWRhdG9yIGNhbGxlZCBpbiBhIGxvZ2ljYWwgZXhwcmVzc2lvbi5cbiAqIEBwYXJhbSB2YWx1ZVxuICogQHBhcmFtIGZ1bmN0b3JzXG4gKiBAcGFyYW0gY29tcGlsZUNvbnRleHRcbiAqIEBwYXJhbSB0b3BvSW5mb1xuICogQHByb3BlcnR5IHtzdHJpbmd9IHRvcG9JbmZvLnRvcG9JZFByZWZpeFxuICogQHByb3BlcnR5IHtzdHJpbmd9IHRvcG9JbmZvLmxhc3RUb3BvSWRcbiAqIEByZXR1cm5zIHsqfHN0cmluZ31cbiAqL1xuZnVuY3Rpb24gY29tcGlsZUFkSG9jVmFsaWRhdG9yKHRvcG9JZCwgdmFsdWUsIGZ1bmN0b3IsIGNvbXBpbGVDb250ZXh0KSB7XG4gICAgYXNzZXJ0OiBmdW5jdG9yLm9vbFR5cGUgPT09IE9vbFR5cGVzLk1vZGlmaWVyLlZBTElEQVRPUjsgICAgICAgIFxuXG4gICAgbGV0IGNhbGxBcmdzO1xuICAgIFxuICAgIGlmIChmdW5jdG9yLmFyZ3MpIHtcbiAgICAgICAgY2FsbEFyZ3MgPSB0cmFuc2xhdGVBcmdzKHRvcG9JZCwgZnVuY3Rvci5hcmdzLCBjb21waWxlQ29udGV4dCk7ICAgICAgICBcbiAgICB9IGVsc2Uge1xuICAgICAgICBjYWxsQXJncyA9IFtdO1xuICAgIH0gICAgICAgICAgICBcbiAgICBcbiAgICBsZXQgYXJnMCA9IHZhbHVlO1xuICAgIFxuICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFt0b3BvSWRdID0gSnNMYW5nLmFzdENhbGwoJ1ZhbGlkYXRvcnMuJyArIGZ1bmN0b3IubmFtZSwgWyBhcmcwIF0uY29uY2F0KGNhbGxBcmdzKSk7XG5cbiAgICByZXR1cm4gdG9wb0lkO1xufVxuXG4vKipcbiAqIENvbXBpbGUgYSBtb2RpZmllciBmcm9tIG9vbCB0byBhc3QuXG4gKiBAcGFyYW0gdmFsdWVcbiAqIEBwYXJhbSBmdW5jdG9yc1xuICogQHBhcmFtIGNvbXBpbGVDb250ZXh0XG4gKiBAcGFyYW0gdG9wb0luZm9cbiAqIEBwcm9wZXJ0eSB7c3RyaW5nfSB0b3BvSW5mby50b3BvSWRQcmVmaXhcbiAqIEBwcm9wZXJ0eSB7c3RyaW5nfSB0b3BvSW5mby5sYXN0VG9wb0lkXG4gKiBAcmV0dXJucyB7KnxzdHJpbmd9XG4gKi9cbmZ1bmN0aW9uIGNvbXBpbGVNb2RpZmllcih0b3BvSWQsIHZhbHVlLCBmdW5jdG9yLCBjb21waWxlQ29udGV4dCkge1xuICAgIGxldCBkZWNsYXJlUGFyYW1zO1xuXG4gICAgaWYgKGZ1bmN0b3Iub29sVHlwZSA9PT0gT29sVHlwZXMuTW9kaWZpZXIuQUNUSVZBVE9SKSB7IFxuICAgICAgICBkZWNsYXJlUGFyYW1zID0gdHJhbnNsYXRlRnVuY3Rpb25QYXJhbXMoZnVuY3Rvci5hcmdzKTsgICAgICAgIFxuICAgIH0gZWxzZSB7XG4gICAgICAgIGRlY2xhcmVQYXJhbXMgPSB0cmFuc2xhdGVGdW5jdGlvblBhcmFtcyhfLmlzRW1wdHkoZnVuY3Rvci5hcmdzKSA/IFt2YWx1ZV0gOiBbdmFsdWVdLmNvbmNhdChmdW5jdG9yLmFyZ3MpKTsgICAgICAgIFxuICAgIH0gICAgICAgIFxuXG4gICAgbGV0IGZ1bmN0b3JJZCA9IHRyYW5zbGF0ZU1vZGlmaWVyKGZ1bmN0b3IsIGNvbXBpbGVDb250ZXh0LCBkZWNsYXJlUGFyYW1zKTtcblxuICAgIGxldCBjYWxsQXJncywgcmVmZXJlbmNlcztcbiAgICBcbiAgICBpZiAoZnVuY3Rvci5hcmdzKSB7XG4gICAgICAgIGNhbGxBcmdzID0gdHJhbnNsYXRlQXJncyh0b3BvSWQsIGZ1bmN0b3IuYXJncywgY29tcGlsZUNvbnRleHQpO1xuICAgICAgICByZWZlcmVuY2VzID0gZXh0cmFjdFJlZmVyZW5jZWRGaWVsZHMoZnVuY3Rvci5hcmdzKTtcblxuICAgICAgICBpZiAoXy5maW5kKHJlZmVyZW5jZXMsIHJlZiA9PiByZWYgPT09IHZhbHVlLm5hbWUpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ0Nhbm5vdCB1c2UgdGhlIHRhcmdldCBmaWVsZCBpdHNlbGYgYXMgYW4gYXJndW1lbnQgb2YgYSBtb2RpZmllci4nKTtcbiAgICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICAgIGNhbGxBcmdzID0gW107XG4gICAgfSAgICAgICAgXG4gICAgXG4gICAgaWYgKGZ1bmN0b3Iub29sVHlwZSA9PT0gT29sVHlwZXMuTW9kaWZpZXIuQUNUSVZBVE9SKSB7ICAgICAgICAgICAgXG4gICAgICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFt0b3BvSWRdID0gSnNMYW5nLmFzdENhbGwoZnVuY3RvcklkLCBjYWxsQXJncyk7XG4gICAgfSBlbHNlIHtcbiAgICAgICAgbGV0IGFyZzAgPSB2YWx1ZTtcbiAgICAgICAgaWYgKCFpc1RvcExldmVsQmxvY2sodG9wb0lkKSAmJiBfLmlzUGxhaW5PYmplY3QodmFsdWUpICYmIHZhbHVlLm9vbFR5cGUgPT09ICdPYmplY3RSZWZlcmVuY2UnICYmIHZhbHVlLm5hbWUuc3RhcnRzV2l0aCgnbGF0ZXN0LicpKSB7XG4gICAgICAgICAgICAvL2xldCBleGlzdGluZ1JlZiA9ICAgICAgICAgICAgXG4gICAgICAgICAgICBhcmcwID0gSnNMYW5nLmFzdENvbmRpdGlvbmFsKFxuICAgICAgICAgICAgICAgIEpzTGFuZy5hc3RDYWxsKCdsYXRlc3QuaGFzT3duUHJvcGVydHknLCBbIGV4dHJhY3RSZWZlcmVuY2VCYXNlTmFtZSh2YWx1ZS5uYW1lKSBdKSwgLyoqIHRlc3QgKi9cbiAgICAgICAgICAgICAgICB2YWx1ZSwgLyoqIGNvbnNlcXVlbnQgKi9cbiAgICAgICAgICAgICAgICByZXBsYWNlVmFyUmVmU2NvcGUodmFsdWUsICdleGlzdGluZycpXG4gICAgICAgICAgICApOyAgXG4gICAgICAgIH1cbiAgICAgICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW3RvcG9JZF0gPSBKc0xhbmcuYXN0Q2FsbChmdW5jdG9ySWQsIFsgYXJnMCBdLmNvbmNhdChjYWxsQXJncykpO1xuICAgIH0gICAgXG5cbiAgICBpZiAoaXNUb3BMZXZlbEJsb2NrKHRvcG9JZCkpIHtcbiAgICAgICAgYWRkQ29kZUJsb2NrKGNvbXBpbGVDb250ZXh0LCB0b3BvSWQsIHtcbiAgICAgICAgICAgIHR5cGU6IE9PTF9NT0RJRklFUl9DT0RFX0ZMQUdbZnVuY3Rvci5vb2xUeXBlXSxcbiAgICAgICAgICAgIHRhcmdldDogdmFsdWUubmFtZSxcbiAgICAgICAgICAgIHJlZmVyZW5jZXM6IHJlZmVyZW5jZXMgICAvLyBsYXRlc3QuLCBleHNpdGluZy4sIHJhdy5cbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgcmV0dXJuIHRvcG9JZDtcbn0gIFxuICAgICAgXG5mdW5jdGlvbiBleHRyYWN0UmVmZXJlbmNlZEZpZWxkcyhvb2xBcmdzKSB7ICAgXG4gICAgb29sQXJncyA9IF8uY2FzdEFycmF5KG9vbEFyZ3MpOyAgICBcblxuICAgIGxldCByZWZzID0gW107XG5cbiAgICBvb2xBcmdzLmZvckVhY2goYSA9PiB7XG4gICAgICAgIGxldCByZXN1bHQgPSBjaGVja1JlZmVyZW5jZVRvRmllbGQoYSk7XG4gICAgICAgIGlmIChyZXN1bHQpIHtcbiAgICAgICAgICAgIHJlZnMucHVzaChyZXN1bHQpO1xuICAgICAgICB9XG4gICAgfSk7XG5cbiAgICByZXR1cm4gcmVmcztcbn1cblxuZnVuY3Rpb24gY2hlY2tSZWZlcmVuY2VUb0ZpZWxkKG9iaikge1xuICAgIGlmIChfLmlzUGxhaW5PYmplY3Qob2JqKSAmJiBvYmoub29sVHlwZSkge1xuICAgICAgICBpZiAob2JqLm9vbFR5cGUgPT09ICdQaXBlZFZhbHVlJykgcmV0dXJuIGNoZWNrUmVmZXJlbmNlVG9GaWVsZChvYmoudmFsdWUpO1xuICAgICAgICBpZiAob2JqLm9vbFR5cGUgPT09ICdPYmplY3RSZWZlcmVuY2UnKSB7XG4gICAgICAgICAgICByZXR1cm4gb2JqLm5hbWU7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICByZXR1cm4gdW5kZWZpbmVkO1xufVxuXG5mdW5jdGlvbiBhZGRNb2RpZmllclRvTWFwKGZ1bmN0b3JJZCwgZnVuY3RvclR5cGUsIGZ1bmN0b3JKc0ZpbGUsIG1hcE9mRnVuY3RvclRvRmlsZSkge1xuICAgIGlmIChtYXBPZkZ1bmN0b3JUb0ZpbGVbZnVuY3RvcklkXSAmJiBtYXBPZkZ1bmN0b3JUb0ZpbGVbZnVuY3RvcklkXSAhPT0gZnVuY3RvckpzRmlsZSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYENvbmZsaWN0OiAke2Z1bmN0b3JUeXBlfSBuYW1pbmcgXCIke2Z1bmN0b3JJZH1cIiBjb25mbGljdHMhYCk7XG4gICAgfVxuICAgIG1hcE9mRnVuY3RvclRvRmlsZVtmdW5jdG9ySWRdID0gZnVuY3RvckpzRmlsZTtcbn1cblxuLyoqXG4gKiBDaGVjayB3aGV0aGVyIGEgZnVuY3RvciBpcyB1c2VyLWRlZmluZWQgb3IgYnVpbHQtaW5cbiAqIEBwYXJhbSBmdW5jdG9yXG4gKiBAcGFyYW0gY29tcGlsZUNvbnRleHRcbiAqIEBwYXJhbSBhcmdzIC0gVXNlZCB0byBtYWtlIHVwIHRoZSBmdW5jdGlvbiBzaWduYXR1cmVcbiAqIEByZXR1cm5zIHtzdHJpbmd9IGZ1bmN0b3IgaWRcbiAqL1xuZnVuY3Rpb24gdHJhbnNsYXRlTW9kaWZpZXIoZnVuY3RvciwgY29tcGlsZUNvbnRleHQsIGFyZ3MpIHtcbiAgICBsZXQgZnVuY3Rpb25OYW1lLCBmaWxlTmFtZSwgZnVuY3RvcklkO1xuXG4gICAgLy9leHRyYWN0IHZhbGlkYXRvciBuYW1pbmcgYW5kIGltcG9ydCBpbmZvcm1hdGlvblxuICAgIGlmIChpc0RvdFNlcGFyYXRlTmFtZShmdW5jdG9yLm5hbWUpKSB7XG4gICAgICAgIGxldCBuYW1lcyA9IGV4dHJhY3REb3RTZXBhcmF0ZU5hbWUoZnVuY3Rvci5uYW1lKTtcbiAgICAgICAgaWYgKG5hbWVzLmxlbmd0aCA+IDIpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignTm90IHN1cHBvcnRlZCByZWZlcmVuY2UgdHlwZTogJyArIGZ1bmN0b3IubmFtZSk7XG4gICAgICAgIH1cblxuICAgICAgICAvL3JlZmVyZW5jZSB0byBvdGhlciBlbnRpdHkgZmlsZVxuICAgICAgICBsZXQgcmVmRW50aXR5TmFtZSA9IG5hbWVzWzBdO1xuICAgICAgICBmdW5jdGlvbk5hbWUgPSBuYW1lc1sxXTtcbiAgICAgICAgZmlsZU5hbWUgPSAnLi8nICsgT09MX01PRElGSUVSX1BBVEhbZnVuY3Rvci5vb2xUeXBlXSArICcvJyArIHJlZkVudGl0eU5hbWUgKyAnLScgKyBmdW5jdGlvbk5hbWUgKyAnLmpzJztcbiAgICAgICAgZnVuY3RvcklkID0gcmVmRW50aXR5TmFtZSArIF8udXBwZXJGaXJzdChmdW5jdGlvbk5hbWUpO1xuICAgICAgICBhZGRNb2RpZmllclRvTWFwKGZ1bmN0b3JJZCwgZnVuY3Rvci5vb2xUeXBlLCBmaWxlTmFtZSwgY29tcGlsZUNvbnRleHQubWFwT2ZGdW5jdG9yVG9GaWxlKTtcblxuICAgIH0gZWxzZSB7XG4gICAgICAgIGZ1bmN0aW9uTmFtZSA9IGZ1bmN0b3IubmFtZTtcblxuICAgICAgICBsZXQgYnVpbHRpbnMgPSBPT0xfTU9ESUZJRVJfQlVJTFRJTltmdW5jdG9yLm9vbFR5cGVdO1xuXG4gICAgICAgIGlmICghKGZ1bmN0aW9uTmFtZSBpbiBidWlsdGlucykpIHtcbiAgICAgICAgICAgIGZpbGVOYW1lID0gJy4vJyArIE9PTF9NT0RJRklFUl9QQVRIW2Z1bmN0b3Iub29sVHlwZV0gKyAnLycgKyBjb21waWxlQ29udGV4dC50YXJnZXROYW1lICsgJy0nICsgZnVuY3Rpb25OYW1lICsgJy5qcyc7XG4gICAgICAgICAgICBmdW5jdG9ySWQgPSBmdW5jdGlvbk5hbWU7XG5cbiAgICAgICAgICAgIGlmICghY29tcGlsZUNvbnRleHQubWFwT2ZGdW5jdG9yVG9GaWxlW2Z1bmN0b3JJZF0pIHtcbiAgICAgICAgICAgICAgICBjb21waWxlQ29udGV4dC5uZXdGdW5jdG9yRmlsZXMucHVzaCh7XG4gICAgICAgICAgICAgICAgICAgIGZ1bmN0aW9uTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgZnVuY3RvclR5cGU6IGZ1bmN0b3Iub29sVHlwZSxcbiAgICAgICAgICAgICAgICAgICAgZmlsZU5hbWUsXG4gICAgICAgICAgICAgICAgICAgIGFyZ3NcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYWRkTW9kaWZpZXJUb01hcChmdW5jdG9ySWQsIGZ1bmN0b3Iub29sVHlwZSwgZmlsZU5hbWUsIGNvbXBpbGVDb250ZXh0Lm1hcE9mRnVuY3RvclRvRmlsZSk7ICAgICAgICAgICAgXG4gICAgICAgIH0gZWxzZSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBmdW5jdG9ySWQgPSBmdW5jdG9yLm9vbFR5cGUgKyAncy4nICsgZnVuY3Rpb25OYW1lO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgcmV0dXJuIGZ1bmN0b3JJZDtcbn1cblxuLyoqXG4gKiBDb21waWxlIGEgcGlwZWQgdmFsdWUgZnJvbSBvb2wgdG8gYXN0LlxuICogQHBhcmFtIHtzdHJpbmd9IHN0YXJ0VG9wb0lkIC0gVGhlIHRvcG9sb2dpY2FsIGlkIG9mIHRoZSBzdGFydGluZyBwcm9jZXNzIHRvIHRoZSB0YXJnZXQgdmFsdWUsIGRlZmF1bHQgYXMgdGhlIHBhcmFtIG5hbWVcbiAqIEBwYXJhbSB7b2JqZWN0fSB2YXJPb2wgLSBUYXJnZXQgdmFsdWUgb29sIG5vZGUuXG4gKiBAcGFyYW0ge29iamVjdH0gY29tcGlsZUNvbnRleHQgLSBDb21waWxhdGlvbiBjb250ZXh0LlxuICogQHByb3BlcnR5IHtzdHJpbmd9IGNvbXBpbGVDb250ZXh0LnRhcmdldE5hbWVcbiAqIEBwcm9wZXJ0eSB7VG9wb1NvcnR9IGNvbXBpbGVDb250ZXh0LnRvcG9Tb3J0XG4gKiBAcHJvcGVydHkge29iamVjdH0gY29tcGlsZUNvbnRleHQuYXN0TWFwIC0gVG9wbyBJZCB0byBhc3QgbWFwXG4gKiBAcmV0dXJucyB7c3RyaW5nfSBMYXN0IHRvcG8gSWRcbiAqL1xuZnVuY3Rpb24gY29tcGlsZVBpcGVkVmFsdWUoc3RhcnRUb3BvSWQsIHZhck9vbCwgY29tcGlsZUNvbnRleHQpIHtcbiAgICBsZXQgbGFzdFRvcG9JZCA9IGNvbXBpbGVDb25jcmV0ZVZhbHVlRXhwcmVzc2lvbihzdGFydFRvcG9JZCwgdmFyT29sLnZhbHVlLCBjb21waWxlQ29udGV4dCk7XG5cbiAgICB2YXJPb2wubW9kaWZpZXJzLmZvckVhY2gobW9kaWZpZXIgPT4ge1xuICAgICAgICBsZXQgbW9kaWZpZXJTdGFydFRvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgc3RhcnRUb3BvSWQgKyBPT0xfTU9ESUZJRVJfT1BbbW9kaWZpZXIub29sVHlwZV0gKyBtb2RpZmllci5uYW1lKTtcbiAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBsYXN0VG9wb0lkLCBtb2RpZmllclN0YXJ0VG9wb0lkKTtcblxuICAgICAgICBsYXN0VG9wb0lkID0gY29tcGlsZU1vZGlmaWVyKFxuICAgICAgICAgICAgbW9kaWZpZXJTdGFydFRvcG9JZCxcbiAgICAgICAgICAgIHZhck9vbC52YWx1ZSxcbiAgICAgICAgICAgIG1vZGlmaWVyLFxuICAgICAgICAgICAgY29tcGlsZUNvbnRleHRcbiAgICAgICAgKTtcbiAgICB9KTtcblxuICAgIHJldHVybiBsYXN0VG9wb0lkO1xufVxuXG4vKipcbiAqIENvbXBpbGUgYSB2YXJpYWJsZSByZWZlcmVuY2UgZnJvbSBvb2wgdG8gYXN0LlxuICogQHBhcmFtIHtzdHJpbmd9IHN0YXJ0VG9wb0lkIC0gVGhlIHRvcG9sb2dpY2FsIGlkIG9mIHRoZSBzdGFydGluZyBwcm9jZXNzIHRvIHRoZSB0YXJnZXQgdmFsdWUsIGRlZmF1bHQgYXMgdGhlIHBhcmFtIG5hbWVcbiAqIEBwYXJhbSB7b2JqZWN0fSB2YXJPb2wgLSBUYXJnZXQgdmFsdWUgb29sIG5vZGUuXG4gKiBAcGFyYW0ge29iamVjdH0gY29tcGlsZUNvbnRleHQgLSBDb21waWxhdGlvbiBjb250ZXh0LlxuICogQHByb3BlcnR5IHtzdHJpbmd9IGNvbXBpbGVDb250ZXh0LnRhcmdldE5hbWVcbiAqIEBwcm9wZXJ0eSB7VG9wb1NvcnR9IGNvbXBpbGVDb250ZXh0LnRvcG9Tb3J0XG4gKiBAcHJvcGVydHkge29iamVjdH0gY29tcGlsZUNvbnRleHQuYXN0TWFwIC0gVG9wbyBJZCB0byBhc3QgbWFwXG4gKiBAcmV0dXJucyB7c3RyaW5nfSBMYXN0IHRvcG8gSWRcbiAqL1xuZnVuY3Rpb24gY29tcGlsZVZhcmlhYmxlUmVmZXJlbmNlKHN0YXJ0VG9wb0lkLCB2YXJPb2wsIGNvbXBpbGVDb250ZXh0KSB7XG4gICAgcHJlOiBfLmlzUGxhaW5PYmplY3QodmFyT29sKSAmJiB2YXJPb2wub29sVHlwZSA9PT0gJ09iamVjdFJlZmVyZW5jZSc7XG5cbiAgICBsZXQgWyBiYXNlTmFtZSwgb3RoZXJzIF0gPSB2YXJPb2wubmFtZS5zcGxpdCgnLicsIDIpO1xuICAgIC8qXG4gICAgaWYgKGNvbXBpbGVDb250ZXh0Lm1vZGVsVmFycyAmJiBjb21waWxlQ29udGV4dC5tb2RlbFZhcnMuaGFzKGJhc2VOYW1lKSAmJiBvdGhlcnMpIHtcbiAgICAgICAgdmFyT29sLm5hbWUgPSBiYXNlTmFtZSArICcuZGF0YScgKyAnLicgKyBvdGhlcnM7XG4gICAgfSovICAgIFxuXG4gICAgLy9zaW1wbGUgdmFsdWVcbiAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbc3RhcnRUb3BvSWRdID0gSnNMYW5nLmFzdFZhbHVlKHZhck9vbCk7XG4gICAgcmV0dXJuIHN0YXJ0VG9wb0lkO1xufVxuXG4vKipcbiAqIEdldCBhbiBhcnJheSBvZiBwYXJhbWV0ZXIgbmFtZXMuXG4gKiBAcGFyYW0ge2FycmF5fSBhcmdzIC0gQW4gYXJyYXkgb2YgYXJndW1lbnRzIGluIG9vbCBzeW50YXhcbiAqIEByZXR1cm5zIHthcnJheX1cbiAqL1xuZnVuY3Rpb24gdHJhbnNsYXRlRnVuY3Rpb25QYXJhbXMoYXJncykge1xuICAgIGlmIChfLmlzRW1wdHkoYXJncykpIHJldHVybiBbXTtcblxuICAgIGxldCBuYW1lcyA9IG5ldyBTZXQoKTtcblxuICAgIGZ1bmN0aW9uIHRyYW5zbGF0ZUZ1bmN0aW9uUGFyYW0oYXJnLCBpKSB7XG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QoYXJnKSkge1xuICAgICAgICAgICAgaWYgKGFyZy5vb2xUeXBlID09PSAnUGlwZWRWYWx1ZScpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdHJhbnNsYXRlRnVuY3Rpb25QYXJhbShhcmcudmFsdWUpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoYXJnLm9vbFR5cGUgPT09ICdPYmplY3RSZWZlcmVuY2UnKSB7XG4gICAgICAgICAgICAgICAgaWYgKGlzRG90U2VwYXJhdGVOYW1lKGFyZy5uYW1lKSkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gZXh0cmFjdERvdFNlcGFyYXRlTmFtZShhcmcubmFtZSkucG9wKCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuXG4gICAgICAgICAgICByZXR1cm4gYXJnLm5hbWU7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gJ3BhcmFtJyArIChpICsgMSkudG9TdHJpbmcoKTtcbiAgICB9XG5cbiAgICByZXR1cm4gXy5tYXAoYXJncywgKGFyZywgaSkgPT4ge1xuICAgICAgICBsZXQgYmFzZU5hbWUgPSB0cmFuc2xhdGVGdW5jdGlvblBhcmFtKGFyZywgaSk7XG4gICAgICAgIGxldCBuYW1lID0gYmFzZU5hbWU7XG4gICAgICAgIGxldCBjb3VudCA9IDI7XG4gICAgICAgIFxuICAgICAgICB3aGlsZSAobmFtZXMuaGFzKG5hbWUpKSB7XG4gICAgICAgICAgICBuYW1lID0gYmFzZU5hbWUgKyBjb3VudC50b1N0cmluZygpO1xuICAgICAgICAgICAgY291bnQrKztcbiAgICAgICAgfVxuXG4gICAgICAgIG5hbWVzLmFkZChuYW1lKTtcbiAgICAgICAgcmV0dXJuIG5hbWU7ICAgICAgICBcbiAgICB9KTtcbn1cblxuLyoqXG4gKiBDb21waWxlIGEgY29uY3JldGUgdmFsdWUgZXhwcmVzc2lvbiBmcm9tIG9vbCB0byBhc3RcbiAqIEBwYXJhbSB7c3RyaW5nfSBzdGFydFRvcG9JZCAtIFRoZSB0b3BvIGlkIG9mIHRoZSBzdGFydGluZyBwcm9jZXNzIHRvIHRoZSB0YXJnZXQgdmFsdWUgZXhwcmVzc2lvblxuICogQHBhcmFtIHtvYmplY3R9IHZhbHVlIC0gT29sIG5vZGVcbiAqIEBwYXJhbSB7b2JqZWN0fSBjb21waWxlQ29udGV4dCAtIENvbXBpbGF0aW9uIGNvbnRleHRcbiAqIEByZXR1cm5zIHtzdHJpbmd9IExhc3QgdG9wb0lkXG4gKi9cbmZ1bmN0aW9uIGNvbXBpbGVDb25jcmV0ZVZhbHVlRXhwcmVzc2lvbihzdGFydFRvcG9JZCwgdmFsdWUsIGNvbXBpbGVDb250ZXh0KSB7XG4gICAgaWYgKF8uaXNQbGFpbk9iamVjdCh2YWx1ZSkpIHtcbiAgICAgICAgaWYgKHZhbHVlLm9vbFR5cGUgPT09ICdQaXBlZFZhbHVlJykge1xuICAgICAgICAgICAgcmV0dXJuIGNvbXBpbGVQaXBlZFZhbHVlKHN0YXJ0VG9wb0lkLCB2YWx1ZSwgY29tcGlsZUNvbnRleHQpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHZhbHVlLm9vbFR5cGUgPT09ICdPYmplY3RSZWZlcmVuY2UnKSB7XG4gICAgICAgICAgICBsZXQgWyByZWZCYXNlLCAuLi5yZXN0IF0gPSBleHRyYWN0RG90U2VwYXJhdGVOYW1lKHZhbHVlLm5hbWUpO1xuXG4gICAgICAgICAgICBsZXQgZGVwZW5kZW5jeTtcblxuICAgICAgICAgICAgaWYgKGNvbXBpbGVDb250ZXh0Lm1vZGVsVmFycyAmJiBjb21waWxlQ29udGV4dC5tb2RlbFZhcnMuaGFzKHJlZkJhc2UpKSB7XG4gICAgICAgICAgICAgICAgLy91c2VyLCB1c2VyLnBhc3N3b3JkIG9yIHVzZXIuZGF0YS5wYXNzd29yZFxuICAgICAgICAgICAgICAgIGRlcGVuZGVuY3kgPSByZWZCYXNlO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChyZWZCYXNlID09PSAnbGF0ZXN0JyAmJiByZXN0Lmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgICAgICAvL2xhdGVzdC5wYXNzd29yZFxuICAgICAgICAgICAgICAgIGxldCByZWZGaWVsZE5hbWUgPSByZXN0LnBvcCgpO1xuICAgICAgICAgICAgICAgIGlmIChyZWZGaWVsZE5hbWUgIT09IHN0YXJ0VG9wb0lkKSB7XG4gICAgICAgICAgICAgICAgICAgIGRlcGVuZGVuY3kgPSByZWZGaWVsZE5hbWUgKyAnOnJlYWR5JztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2UgaWYgKF8uaXNFbXB0eShyZXN0KSkge1xuICAgICAgICAgICAgICAgIGRlcGVuZGVuY3kgPSByZWZCYXNlICsgJzpyZWFkeSc7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5yZWNvZ25pemVkIG9iamVjdCByZWZlcmVuY2U6ICcgKyBKU09OLnN0cmluZ2lmeSh2YWx1ZSkpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoZGVwZW5kZW5jeSkge1xuICAgICAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgZGVwZW5kZW5jeSwgc3RhcnRUb3BvSWQpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gY29tcGlsZVZhcmlhYmxlUmVmZXJlbmNlKHN0YXJ0VG9wb0lkLCB2YWx1ZSwgY29tcGlsZUNvbnRleHQpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHZhbHVlLm9vbFR5cGUgPT09ICdSZWdFeHAnKSB7XG4gICAgICAgICAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbc3RhcnRUb3BvSWRdID0gSnNMYW5nLmFzdFZhbHVlKHZhbHVlKTtcbiAgICAgICAgICAgIC8vY29uc29sZS5sb2coY29tcGlsZUNvbnRleHQuYXN0TWFwW3N0YXJ0VG9wb0lkXSk7XG4gICAgICAgICAgICAvL3Rocm93IG5ldyBFcnJvcihzdGFydFRvcG9JZCk7XG4gICAgICAgICAgICByZXR1cm4gc3RhcnRUb3BvSWQ7XG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgIHZhbHVlID0gXy5tYXBWYWx1ZXModmFsdWUsICh2YWx1ZU9mRWxlbWVudCwga2V5KSA9PiB7IFxuICAgICAgICAgICAgbGV0IHNpZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgc3RhcnRUb3BvSWQgKyAnLicgKyBrZXkpO1xuICAgICAgICAgICAgbGV0IGVpZCA9IGNvbXBpbGVDb25jcmV0ZVZhbHVlRXhwcmVzc2lvbihzaWQsIHZhbHVlT2ZFbGVtZW50LCBjb21waWxlQ29udGV4dCk7XG4gICAgICAgICAgICBpZiAoc2lkICE9PSBlaWQpIHtcbiAgICAgICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIGVpZCwgc3RhcnRUb3BvSWQpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtlaWRdO1xuICAgICAgICB9KTtcbiAgICB9IGVsc2UgaWYgKEFycmF5LmlzQXJyYXkodmFsdWUpKSB7XG4gICAgICAgIHZhbHVlID0gXy5tYXAodmFsdWUsICh2YWx1ZU9mRWxlbWVudCwgaW5kZXgpID0+IHsgXG4gICAgICAgICAgICBsZXQgc2lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCArICdbJyArIGluZGV4ICsgJ10nKTtcbiAgICAgICAgICAgIGxldCBlaWQgPSBjb21waWxlQ29uY3JldGVWYWx1ZUV4cHJlc3Npb24oc2lkLCB2YWx1ZU9mRWxlbWVudCwgY29tcGlsZUNvbnRleHQpO1xuICAgICAgICAgICAgaWYgKHNpZCAhPT0gZWlkKSB7XG4gICAgICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBlaWQsIHN0YXJ0VG9wb0lkKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiBjb21waWxlQ29udGV4dC5hc3RNYXBbZWlkXTtcbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW3N0YXJ0VG9wb0lkXSA9IEpzTGFuZy5hc3RWYWx1ZSh2YWx1ZSk7XG4gICAgcmV0dXJuIHN0YXJ0VG9wb0lkO1xufVxuXG4vKipcbiAqIFRyYW5zbGF0ZSBhbiBhcnJheSBvZiBmdW5jdGlvbiBhcmd1bWVudHMgZnJvbSBvb2wgaW50byBhc3QuXG4gKiBAcGFyYW0gdG9wb0lkIC0gVGhlIG1vZGlmaWVyIGZ1bmN0aW9uIHRvcG8gXG4gKiBAcGFyYW0gYXJncyAtIFxuICogQHBhcmFtIGNvbXBpbGVDb250ZXh0IC0gXG4gKiBAcmV0dXJucyB7QXJyYXl9XG4gKi9cbmZ1bmN0aW9uIHRyYW5zbGF0ZUFyZ3ModG9wb0lkLCBhcmdzLCBjb21waWxlQ29udGV4dCkge1xuICAgIGFyZ3MgPSBfLmNhc3RBcnJheShhcmdzKTtcbiAgICBpZiAoXy5pc0VtcHR5KGFyZ3MpKSByZXR1cm4gW107XG5cbiAgICBsZXQgY2FsbEFyZ3MgPSBbXTtcblxuICAgIF8uZWFjaChhcmdzLCAoYXJnLCBpKSA9PiB7ICAgICAgICAgICAgICAgIFxuICAgICAgICBsZXQgYXJnVG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCB0b3BvSWQgKyAnOmFyZ1snICsgKGkrMSkudG9TdHJpbmcoKSArICddJyk7XG4gICAgICAgIGxldCBsYXN0VG9wb0lkID0gY29tcGlsZUNvbmNyZXRlVmFsdWVFeHByZXNzaW9uKGFyZ1RvcG9JZCwgYXJnLCBjb21waWxlQ29udGV4dCk7XG5cbiAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBsYXN0VG9wb0lkLCB0b3BvSWQpO1xuXG4gICAgICAgIGNhbGxBcmdzID0gY2FsbEFyZ3MuY29uY2F0KF8uY2FzdEFycmF5KGdldENvZGVSZXByZXNlbnRhdGlvbk9mKGxhc3RUb3BvSWQsIGNvbXBpbGVDb250ZXh0KSkpO1xuICAgIH0pO1xuXG4gICAgcmV0dXJuIGNhbGxBcmdzO1xufVxuXG4vKipcbiAqIENvbXBpbGUgYSBwYXJhbSBvZiBpbnRlcmZhY2UgZnJvbSBvb2wgaW50byBhc3RcbiAqIEBwYXJhbSBpbmRleFxuICogQHBhcmFtIHBhcmFtXG4gKiBAcGFyYW0gY29tcGlsZUNvbnRleHRcbiAqIEByZXR1cm5zIHtzdHJpbmd9XG4gKi9cbmZ1bmN0aW9uIGNvbXBpbGVQYXJhbShpbmRleCwgcGFyYW0sIGNvbXBpbGVDb250ZXh0KSB7XG4gICAgbGV0IHR5cGUgPSBwYXJhbS50eXBlOyAgICBcblxuICAgIGxldCB0eXBlT2JqZWN0ID0gVHlwZXNbdHlwZV07XG5cbiAgICBpZiAoIXR5cGVPYmplY3QpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbmtub3duIGZpZWxkIHR5cGU6ICcgKyB0eXBlKTtcbiAgICB9XG5cbiAgICBsZXQgc2FuaXRpemVyTmFtZSA9IGBUeXBlcy4ke3R5cGUudG9VcHBlckNhc2UoKX0uc2FuaXRpemVgO1xuXG4gICAgbGV0IHZhclJlZiA9IEpzTGFuZy5hc3RWYXJSZWYocGFyYW0ubmFtZSk7XG4gICAgbGV0IGNhbGxBc3QgPSBKc0xhbmcuYXN0Q2FsbChzYW5pdGl6ZXJOYW1lLCBbdmFyUmVmLCBKc0xhbmcuYXN0QXJyYXlBY2Nlc3MoJyRtZXRhLnBhcmFtcycsIGluZGV4KSwgSnNMYW5nLmFzdFZhclJlZigndGhpcy5kYi5pMThuJyldKTtcblxuICAgIGxldCBwcmVwYXJlVG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCAnJHBhcmFtczpzYW5pdGl6ZVsnICsgaW5kZXgudG9TdHJpbmcoKSArICddJyk7XG4gICAgLy9sZXQgc2FuaXRpemVTdGFydGluZztcblxuICAgIC8vaWYgKGluZGV4ID09PSAwKSB7XG4gICAgICAgIC8vZGVjbGFyZSAkc2FuaXRpemVTdGF0ZSB2YXJpYWJsZSBmb3IgdGhlIGZpcnN0IHRpbWVcbiAgICAvLyAgICBzYW5pdGl6ZVN0YXJ0aW5nID0gSnNMYW5nLmFzdFZhckRlY2xhcmUodmFyUmVmLCBjYWxsQXN0LCBmYWxzZSwgZmFsc2UsIGBTYW5pdGl6ZSBwYXJhbSBcIiR7cGFyYW0ubmFtZX1cImApO1xuICAgIC8vfSBlbHNlIHtcbiAgICAvL2xldCBzYW5pdGl6ZVN0YXJ0aW5nID0gO1xuXG4gICAgICAgIC8vbGV0IGxhc3RQcmVwYXJlVG9wb0lkID0gJyRwYXJhbXM6c2FuaXRpemVbJyArIChpbmRleCAtIDEpLnRvU3RyaW5nKCkgKyAnXSc7XG4gICAgICAgIC8vZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBsYXN0UHJlcGFyZVRvcG9JZCwgcHJlcGFyZVRvcG9JZCk7XG4gICAgLy99XG5cbiAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbcHJlcGFyZVRvcG9JZF0gPSBbXG4gICAgICAgIEpzTGFuZy5hc3RBc3NpZ24odmFyUmVmLCBjYWxsQXN0LCBgU2FuaXRpemUgYXJndW1lbnQgXCIke3BhcmFtLm5hbWV9XCJgKVxuICAgIF07XG5cbiAgICBhZGRDb2RlQmxvY2soY29tcGlsZUNvbnRleHQsIHByZXBhcmVUb3BvSWQsIHtcbiAgICAgICAgdHlwZTogQVNUX0JMS19QQVJBTV9TQU5JVElaRVxuICAgIH0pO1xuXG4gICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBwcmVwYXJlVG9wb0lkLCBjb21waWxlQ29udGV4dC5tYWluU3RhcnRJZCk7XG5cbiAgICBsZXQgdG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBwYXJhbS5uYW1lKTtcbiAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIGNvbXBpbGVDb250ZXh0Lm1haW5TdGFydElkLCB0b3BvSWQpO1xuXG4gICAgbGV0IHZhbHVlID0gd3JhcFBhcmFtUmVmZXJlbmNlKHBhcmFtLm5hbWUsIHBhcmFtKTtcbiAgICBsZXQgZW5kVG9wb0lkID0gY29tcGlsZVZhcmlhYmxlUmVmZXJlbmNlKHRvcG9JZCwgdmFsdWUsIGNvbXBpbGVDb250ZXh0KTtcblxuICAgIGxldCByZWFkeVRvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgdG9wb0lkICsgJzpyZWFkeScpO1xuICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgZW5kVG9wb0lkLCByZWFkeVRvcG9JZCk7XG5cbiAgICByZXR1cm4gcmVhZHlUb3BvSWQ7XG59XG5cbi8qKlxuICogQ29tcGlsZSBhIG1vZGVsIGZpZWxkIHByZXByb2Nlc3MgaW5mb3JtYXRpb24gaW50byBhc3QuXG4gKiBAcGFyYW0ge29iamVjdH0gcGFyYW0gLSBGaWVsZCBpbmZvcm1hdGlvblxuICogQHBhcmFtIHtvYmplY3R9IGNvbXBpbGVDb250ZXh0IC0gQ29tcGlsYXRpb24gY29udGV4dFxuICogQHJldHVybnMge3N0cmluZ31cbiAqL1xuZnVuY3Rpb24gY29tcGlsZUZpZWxkKHBhcmFtTmFtZSwgcGFyYW0sIGNvbXBpbGVDb250ZXh0KSB7XG4gICAgLy8gMS4gcmVmZXJlbmNlIHRvIHRoZSBsYXRlc3Qgb2JqZWN0IHRoYXQgaXMgcGFzc2VkIHF1YWxpZmllciBjaGVja3NcbiAgICAvLyAyLiBpZiBtb2RpZmllcnMgZXhpc3QsIHdyYXAgdGhlIHJlZiBpbnRvIGEgcGlwZWQgdmFsdWVcbiAgICAvLyAzLiBwcm9jZXNzIHRoZSByZWYgKG9yIHBpcGVkIHJlZikgYW5kIG1hcmsgYXMgZW5kXG4gICAgLy8gNC4gYnVpbGQgZGVwZW5kZW5jaWVzOiBsYXRlc3QuZmllbGQgLT4gLi4uIC0+IGZpZWxkOnJlYWR5IFxuICAgIGxldCB0b3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIHBhcmFtTmFtZSk7XG4gICAgbGV0IGNvbnRleHROYW1lID0gJ2xhdGVzdC4nICsgcGFyYW1OYW1lO1xuICAgIC8vY29tcGlsZUNvbnRleHQuYXN0TWFwW3RvcG9JZF0gPSBKc0xhbmcuYXN0VmFyUmVmKGNvbnRleHROYW1lLCB0cnVlKTtcblxuICAgIGxldCB2YWx1ZSA9IHdyYXBQYXJhbVJlZmVyZW5jZShjb250ZXh0TmFtZSwgcGFyYW0pOyAgICBcbiAgICBsZXQgZW5kVG9wb0lkID0gY29tcGlsZUNvbmNyZXRlVmFsdWVFeHByZXNzaW9uKHRvcG9JZCwgdmFsdWUsIGNvbXBpbGVDb250ZXh0KTtcblxuICAgIGxldCByZWFkeVRvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgdG9wb0lkICsgJzpyZWFkeScpO1xuICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgZW5kVG9wb0lkLCByZWFkeVRvcG9JZCk7XG5cbiAgICByZXR1cm4gcmVhZHlUb3BvSWQ7XG59XG5cbmZ1bmN0aW9uIHdyYXBQYXJhbVJlZmVyZW5jZShuYW1lLCB2YWx1ZSkge1xuICAgIGxldCByZWYgPSBPYmplY3QuYXNzaWduKHsgb29sVHlwZTogJ09iamVjdFJlZmVyZW5jZScsIG5hbWU6IG5hbWUgfSk7XG4gICAgXG4gICAgaWYgKCFfLmlzRW1wdHkodmFsdWUubW9kaWZpZXJzKSkge1xuICAgICAgICByZXR1cm4geyBvb2xUeXBlOiAnUGlwZWRWYWx1ZScsIHZhbHVlOiByZWYsIG1vZGlmaWVyczogdmFsdWUubW9kaWZpZXJzIH07XG4gICAgfVxuICAgIFxuICAgIHJldHVybiByZWY7XG59XG5cbi8qKlxuICogVHJhbnNsYXRlIGEgdGhlbiBjbGF1c2UgZnJvbSBvb2wgaW50byBhc3RcbiAqIEBwYXJhbSB7c3RyaW5nfSBzdGFydElkXG4gKiBAcGFyYW0ge3N0cmluZ30gZW5kSWRcbiAqIEBwYXJhbSB0aGVuXG4gKiBAcGFyYW0gY29tcGlsZUNvbnRleHRcbiAqIEBwYXJhbSBhc3NpZ25Ub1xuICogQHJldHVybnMge29iamVjdH0gQVNUIG9iamVjdFxuICovXG5mdW5jdGlvbiB0cmFuc2xhdGVUaGVuQXN0KHN0YXJ0SWQsIGVuZElkLCB0aGVuLCBjb21waWxlQ29udGV4dCwgYXNzaWduVG8pIHtcbiAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHRoZW4pKSB7XG4gICAgICAgIGlmICh0aGVuLm9vbFR5cGUgPT09ICdUaHJvd0V4cHJlc3Npb24nKSB7XG4gICAgICAgICAgICBsZXQgYXJncztcbiAgICAgICAgICAgIGlmICh0aGVuLmFyZ3MpIHtcbiAgICAgICAgICAgICAgICBhcmdzID0gdHJhbnNsYXRlQXJncyhzdGFydElkLCB0aGVuLmFyZ3MsIGNvbXBpbGVDb250ZXh0KTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgYXJncyA9IFtdO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIEpzTGFuZy5hc3RUaHJvdyh0aGVuLmVycm9yVHlwZSB8fCBkZWZhdWx0RXJyb3IsIHRoZW4ubWVzc2FnZSB8fCBhcmdzKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICh0aGVuLm9vbFR5cGUgPT09ICdSZXR1cm5FeHByZXNzaW9uJykge1xuICAgICAgICAgICAgcmV0dXJuIHRyYW5zbGF0ZVJldHVyblZhbHVlQXN0KHN0YXJ0SWQsIGVuZElkLCB0aGVuLnZhbHVlLCBjb21waWxlQ29udGV4dCk7XG4gICAgICAgIH0gICAgICAgIFxuICAgIH1cblxuICAgIC8vdGhlbiBleHByZXNzaW9uIGlzIGFuIG9vbG9uZyBjb25jcmV0ZSB2YWx1ZSAgICBcbiAgICBpZiAoXy5pc0FycmF5KHRoZW4pIHx8IF8uaXNQbGFpbk9iamVjdCh0aGVuKSkge1xuICAgICAgICBsZXQgdmFsdWVFbmRJZCA9IGNvbXBpbGVDb25jcmV0ZVZhbHVlRXhwcmVzc2lvbihzdGFydElkLCB0aGVuLCBjb21waWxlQ29udGV4dCk7ICAgIFxuICAgICAgICB0aGVuID0gY29tcGlsZUNvbnRleHQuYXN0TWFwW3ZhbHVlRW5kSWRdOyBcbiAgICB9ICAgXG5cbiAgICBpZiAoIWFzc2lnblRvKSB7XG4gICAgICAgIHJldHVybiBKc0xhbmcuYXN0UmV0dXJuKHRoZW4pO1xuICAgIH1cblxuICAgIHJldHVybiBKc0xhbmcuYXN0QXNzaWduKGFzc2lnblRvLCB0aGVuKTtcbn1cblxuLyoqXG4gKiBUcmFuc2xhdGUgYSByZXR1cm4gY2xhdXNlIGZyb20gb29sIGludG8gYXN0XG4gKiBAcGFyYW0ge3N0cmluZ30gc3RhcnRUb3BvSWQgLSBUaGUgdG9wbyBpZCBvZiB0aGUgc3RhcnRpbmcgc3RhdGUgb2YgcmV0dXJuIGNsYXVzZVxuICogQHBhcmFtIHtzdHJpbmd9IGVuZFRvcG9JZCAtIFRoZSB0b3BvIGlkIG9mIHRoZSBlbmRpbmcgc3RhdGUgb2YgcmV0dXJuIGNsYXVzZVxuICogQHBhcmFtIHZhbHVlXG4gKiBAcGFyYW0gY29tcGlsZUNvbnRleHRcbiAqIEByZXR1cm5zIHtvYmplY3R9IEFTVCBvYmplY3RcbiAqL1xuZnVuY3Rpb24gdHJhbnNsYXRlUmV0dXJuVmFsdWVBc3Qoc3RhcnRUb3BvSWQsIGVuZFRvcG9JZCwgdmFsdWUsIGNvbXBpbGVDb250ZXh0KSB7XG4gICAgbGV0IHZhbHVlVG9wb0lkID0gY29tcGlsZUNvbmNyZXRlVmFsdWVFeHByZXNzaW9uKHN0YXJ0VG9wb0lkLCB2YWx1ZSwgY29tcGlsZUNvbnRleHQpO1xuICAgIGlmICh2YWx1ZVRvcG9JZCAhPT0gc3RhcnRUb3BvSWQpIHtcbiAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCB2YWx1ZVRvcG9JZCwgZW5kVG9wb0lkKTtcbiAgICB9XG5cbiAgICByZXR1cm4gSnNMYW5nLmFzdFJldHVybihnZXRDb2RlUmVwcmVzZW50YXRpb25PZih2YWx1ZVRvcG9JZCwgY29tcGlsZUNvbnRleHQpKTtcbn1cblxuLyoqXG4gKiBDb21waWxlIGEgcmV0dXJuIGNsYXVzZSBmcm9tIG9vbCBpbnRvIGFzdFxuICogQHBhcmFtIHtzdHJpbmd9IHN0YXJ0VG9wb0lkIC0gVGhlIHRvcG8gaWQgb2YgdGhlIHN0YXJ0aW5nIHByb2Nlc3MgdG8gdGhlIHRhcmdldCB2YWx1ZSBleHByZXNzaW9uXG4gKiBAcGFyYW0gdmFsdWVcbiAqIEBwYXJhbSBjb21waWxlQ29udGV4dFxuICogQHJldHVybnMge29iamVjdH0gQVNUIG9iamVjdFxuICovXG5mdW5jdGlvbiBjb21waWxlUmV0dXJuKHN0YXJ0VG9wb0lkLCB2YWx1ZSwgY29tcGlsZUNvbnRleHQpIHtcbiAgICBsZXQgZW5kVG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCAnJHJldHVybicpO1xuICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgc3RhcnRUb3BvSWQsIGVuZFRvcG9JZCk7XG5cbiAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbZW5kVG9wb0lkXSA9IHRyYW5zbGF0ZVJldHVyblZhbHVlQXN0KHN0YXJ0VG9wb0lkLCBlbmRUb3BvSWQsIHZhbHVlLCBjb21waWxlQ29udGV4dCk7XG5cbiAgICBhZGRDb2RlQmxvY2soY29tcGlsZUNvbnRleHQsIGVuZFRvcG9JZCwge1xuICAgICAgICB0eXBlOiBBU1RfQkxLX1ZJRVdfUkVUVVJOXG4gICAgfSk7XG5cbiAgICByZXR1cm4gZW5kVG9wb0lkO1xufVxuXG4vKipcbiAqIENvbXBpbGUgYSBmaW5kIG9uZSBvcGVyYXRpb24gZnJvbSBvb2wgaW50byBhc3RcbiAqIEBwYXJhbSB7aW50fSBpbmRleFxuICogQHBhcmFtIHtvYmplY3R9IG9wZXJhdGlvbiAtIE9vbCBub2RlXG4gKiBAcGFyYW0ge29iamVjdH0gY29tcGlsZUNvbnRleHQgLVxuICogQHBhcmFtIHtzdHJpbmd9IGRlcGVuZGVuY3lcbiAqIEByZXR1cm5zIHtzdHJpbmd9IGxhc3QgdG9wb0lkXG4gKi9cbmZ1bmN0aW9uIGNvbXBpbGVGaW5kT25lKGluZGV4LCBvcGVyYXRpb24sIGNvbXBpbGVDb250ZXh0LCBkZXBlbmRlbmN5KSB7XG4gICAgcHJlOiBkZXBlbmRlbmN5O1xuXG4gICAgbGV0IGVuZFRvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgJ29wJCcgKyBpbmRleC50b1N0cmluZygpKTtcbiAgICBsZXQgY29uZGl0aW9uVmFyTmFtZSA9IGVuZFRvcG9JZCArICckY29uZGl0aW9uJztcblxuICAgIGxldCBhc3QgPSBbXG4gICAgICAgIEpzTGFuZy5hc3RWYXJEZWNsYXJlKGNvbmRpdGlvblZhck5hbWUpXG4gICAgXTtcblxuICAgIGFzc2VydDogb3BlcmF0aW9uLmNvbmRpdGlvbjtcblxuICAgIGlmIChvcGVyYXRpb24uY29uZGl0aW9uLm9vbFR5cGUpIHtcbiAgICAgICAgLy9zcGVjaWFsIGNvbmRpdGlvblxuXG4gICAgICAgIGlmIChvcGVyYXRpb24uY29uZGl0aW9uLm9vbFR5cGUgPT09ICdjYXNlcycpIHtcbiAgICAgICAgICAgIGxldCB0b3BvSWRQcmVmaXggPSBlbmRUb3BvSWQgKyAnJGNhc2VzJztcbiAgICAgICAgICAgIGxldCBsYXN0U3RhdGVtZW50O1xuXG4gICAgICAgICAgICBpZiAob3BlcmF0aW9uLmNvbmRpdGlvbi5lbHNlKSB7XG4gICAgICAgICAgICAgICAgbGV0IGVsc2VTdGFydCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgdG9wb0lkUHJlZml4ICsgJzplbHNlJyk7XG4gICAgICAgICAgICAgICAgbGV0IGVsc2VFbmQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIHRvcG9JZFByZWZpeCArICc6ZW5kJyk7XG4gICAgICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBlbHNlU3RhcnQsIGVsc2VFbmQpO1xuICAgICAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgZWxzZUVuZCwgZW5kVG9wb0lkKTtcblxuICAgICAgICAgICAgICAgIGxhc3RTdGF0ZW1lbnQgPSB0cmFuc2xhdGVUaGVuQXN0KGVsc2VTdGFydCwgZWxzZUVuZCwgb3BlcmF0aW9uLmNvbmRpdGlvbi5lbHNlLCBjb21waWxlQ29udGV4dCwgY29uZGl0aW9uVmFyTmFtZSk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGxhc3RTdGF0ZW1lbnQgPSBKc0xhbmcuYXN0VGhyb3coJ1NlcnZlckVycm9yJywgJ1VuZXhwZWN0ZWQgc3RhdGUuJyk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChfLmlzRW1wdHkob3BlcmF0aW9uLmNvbmRpdGlvbi5pdGVtcykpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ01pc3NpbmcgY2FzZSBpdGVtcycpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBfLnJldmVyc2Uob3BlcmF0aW9uLmNvbmRpdGlvbi5pdGVtcykuZm9yRWFjaCgoaXRlbSwgaSkgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChpdGVtLm9vbFR5cGUgIT09ICdDb25kaXRpb25hbFN0YXRlbWVudCcpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdJbnZhbGlkIGNhc2UgaXRlbS4nKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpID0gb3BlcmF0aW9uLmNvbmRpdGlvbi5pdGVtcy5sZW5ndGggLSBpIC0gMTtcblxuICAgICAgICAgICAgICAgIGxldCBjYXNlUHJlZml4ID0gdG9wb0lkUHJlZml4ICsgJ1snICsgaS50b1N0cmluZygpICsgJ10nO1xuICAgICAgICAgICAgICAgIGxldCBjYXNlVG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBjYXNlUHJlZml4KTtcbiAgICAgICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIGRlcGVuZGVuY3ksIGNhc2VUb3BvSWQpO1xuXG4gICAgICAgICAgICAgICAgbGV0IGNhc2VSZXN1bHRWYXJOYW1lID0gJyQnICsgdG9wb0lkUHJlZml4ICsgJ18nICsgaS50b1N0cmluZygpO1xuXG4gICAgICAgICAgICAgICAgbGV0IGxhc3RUb3BvSWQgPSBjb21waWxlQ29uZGl0aW9uYWxFeHByZXNzaW9uKGl0ZW0udGVzdCwgY29tcGlsZUNvbnRleHQsIGNhc2VUb3BvSWQpO1xuICAgICAgICAgICAgICAgIGxldCBhc3RDYXNlVHRlbSA9IGdldENvZGVSZXByZXNlbnRhdGlvbk9mKGxhc3RUb3BvSWQsIGNvbXBpbGVDb250ZXh0KTtcblxuICAgICAgICAgICAgICAgIGFzc2VydDogIUFycmF5LmlzQXJyYXkoYXN0Q2FzZVR0ZW0pLCAnSW52YWxpZCBjYXNlIGl0ZW0gYXN0Lic7XG5cbiAgICAgICAgICAgICAgICBhc3RDYXNlVHRlbSA9IEpzTGFuZy5hc3RWYXJEZWNsYXJlKGNhc2VSZXN1bHRWYXJOYW1lLCBhc3RDYXNlVHRlbSwgdHJ1ZSwgZmFsc2UsIGBDb25kaXRpb24gJHtpfSBmb3IgZmluZCBvbmUgJHtvcGVyYXRpb24ubW9kZWx9YCk7XG5cbiAgICAgICAgICAgICAgICBsZXQgaWZTdGFydCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgY2FzZVByZWZpeCArICc6dGhlbicpO1xuICAgICAgICAgICAgICAgIGxldCBpZkVuZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgY2FzZVByZWZpeCArICc6ZW5kJyk7XG4gICAgICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBsYXN0VG9wb0lkLCBpZlN0YXJ0KTtcbiAgICAgICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIGlmU3RhcnQsIGlmRW5kKTtcblxuICAgICAgICAgICAgICAgIGxhc3RTdGF0ZW1lbnQgPSBbXG4gICAgICAgICAgICAgICAgICAgIGFzdENhc2VUdGVtLFxuICAgICAgICAgICAgICAgICAgICBKc0xhbmcuYXN0SWYoSnNMYW5nLmFzdFZhclJlZihjYXNlUmVzdWx0VmFyTmFtZSksIEpzTGFuZy5hc3RCbG9jayh0cmFuc2xhdGVUaGVuQXN0KGlmU3RhcnQsIGlmRW5kLCBpdGVtLnRoZW4sIGNvbXBpbGVDb250ZXh0LCBjb25kaXRpb25WYXJOYW1lKSksIGxhc3RTdGF0ZW1lbnQpXG4gICAgICAgICAgICAgICAgXTtcbiAgICAgICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIGlmRW5kLCBlbmRUb3BvSWQpO1xuICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgIGFzdCA9IGFzdC5jb25jYXQoXy5jYXN0QXJyYXkobGFzdFN0YXRlbWVudCkpO1xuICAgICAgICB9XG5cblxuICAgIH1cblxuICAgIGFzdC5wdXNoKFxuICAgICAgICBKc0xhbmcuYXN0VmFyRGVjbGFyZShvcGVyYXRpb24ubW9kZWwsIEpzTGFuZy5hc3RBd2FpdChgdGhpcy5maW5kT25lX2AsIEpzTGFuZy5hc3RWYXJSZWYoY29uZGl0aW9uVmFyTmFtZSkpKVxuICAgICk7XG5cbiAgICBsZXQgbW9kZWxUb3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIG9wZXJhdGlvbi5tb2RlbCk7XG4gICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBlbmRUb3BvSWQsIG1vZGVsVG9wb0lkKTtcbiAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbZW5kVG9wb0lkXSA9IGFzdDtcbiAgICByZXR1cm4gZW5kVG9wb0lkO1xufVxuXG5mdW5jdGlvbiBjb21waWxlRGJPcGVyYXRpb24oaW5kZXgsIG9wZXJhdGlvbiwgY29tcGlsZUNvbnRleHQsIGRlcGVuZGVuY3kpIHtcbiAgICBsZXQgbGFzdFRvcG9JZDtcblxuICAgIHN3aXRjaCAob3BlcmF0aW9uLm9vbFR5cGUpIHtcbiAgICAgICAgY2FzZSAnZmluZE9uZSc6XG4gICAgICAgICAgICBsYXN0VG9wb0lkID0gY29tcGlsZUZpbmRPbmUoaW5kZXgsIG9wZXJhdGlvbiwgY29tcGlsZUNvbnRleHQsIGRlcGVuZGVuY3kpO1xuICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgY2FzZSAnZmluZCc6XG4gICAgICAgICAgICAvL3ByZXBhcmVEYkNvbm5lY3Rpb24oY29tcGlsZUNvbnRleHQpO1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCd0YmknKTtcbiAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgIGNhc2UgJ3VwZGF0ZSc6XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ3RiaScpO1xuICAgICAgICAgICAgLy9wcmVwYXJlRGJDb25uZWN0aW9uKGNvbXBpbGVDb250ZXh0KTtcbiAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgIGNhc2UgJ2NyZWF0ZSc6XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ3RiaScpO1xuICAgICAgICAgICAgLy9wcmVwYXJlRGJDb25uZWN0aW9uKGNvbXBpbGVDb250ZXh0KTtcbiAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgIGNhc2UgJ2RlbGV0ZSc6XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ3RiaScpO1xuICAgICAgICAgICAgLy9wcmVwYXJlRGJDb25uZWN0aW9uKGNvbXBpbGVDb250ZXh0KTtcbiAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgIGNhc2UgJ2phdmFzY3JpcHQnOlxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCd0YmknKTtcbiAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgIGNhc2UgJ2Fzc2lnbm1lbnQnOlxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCd0YmknKTtcbiAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1Vuc3VwcG9ydGVkIG9wZXJhdGlvbiB0eXBlOiAnICsgb3BlcmF0aW9uLnR5cGUpO1xuICAgIH1cblxuICAgIGFkZENvZGVCbG9jayhjb21waWxlQ29udGV4dCwgbGFzdFRvcG9JZCwge1xuICAgICAgICB0eXBlOiBBU1RfQkxLX0lOVEVSRkFDRV9PUEVSQVRJT05cbiAgICB9KTtcblxuICAgIHJldHVybiBsYXN0VG9wb0lkO1xufVxuXG4vKipcbiAqIENvbXBpbGUgZXhjZXB0aW9uYWwgcmV0dXJuIFxuICogQHBhcmFtIHtvYmplY3R9IG9vbE5vZGVcbiAqIEBwYXJhbSB7b2JqZWN0fSBjb21waWxlQ29udGV4dFxuICogQHBhcmFtIHtzdHJpbmd9IFtkZXBlbmRlbmN5XVxuICogQHJldHVybnMge3N0cmluZ30gbGFzdCB0b3BvSWRcbiAqL1xuZnVuY3Rpb24gY29tcGlsZUV4Y2VwdGlvbmFsUmV0dXJuKG9vbE5vZGUsIGNvbXBpbGVDb250ZXh0LCBkZXBlbmRlbmN5KSB7XG4gICAgcHJlOiAoXy5pc1BsYWluT2JqZWN0KG9vbE5vZGUpICYmIG9vbE5vZGUub29sVHlwZSA9PT0gJ1JldHVybkV4cHJlc3Npb24nKTtcblxuICAgIGxldCBlbmRUb3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsICckcmV0dXJuJyksIGxhc3RFeGNlcHRpb25JZCA9IGRlcGVuZGVuY3k7XG5cbiAgICBpZiAoIV8uaXNFbXB0eShvb2xOb2RlLmV4Y2VwdGlvbnMpKSB7XG4gICAgICAgIG9vbE5vZGUuZXhjZXB0aW9ucy5mb3JFYWNoKChpdGVtLCBpKSA9PiB7XG4gICAgICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGl0ZW0pKSB7XG4gICAgICAgICAgICAgICAgaWYgKGl0ZW0ub29sVHlwZSAhPT0gJ0NvbmRpdGlvbmFsU3RhdGVtZW50Jykge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1Vuc3VwcG9ydGVkIGV4Y2VwdGlvbmFsIHR5cGU6ICcgKyBpdGVtLm9vbFR5cGUpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGxldCBleGNlcHRpb25TdGFydElkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBlbmRUb3BvSWQgKyAnOmV4Y2VwdFsnICsgaS50b1N0cmluZygpICsgJ10nKTtcbiAgICAgICAgICAgICAgICBsZXQgZXhjZXB0aW9uRW5kSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIGVuZFRvcG9JZCArICc6ZXhjZXB0WycgKyBpLnRvU3RyaW5nKCkgKyAnXTpkb25lJyk7XG4gICAgICAgICAgICAgICAgaWYgKGxhc3RFeGNlcHRpb25JZCkge1xuICAgICAgICAgICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIGxhc3RFeGNlcHRpb25JZCwgZXhjZXB0aW9uU3RhcnRJZCk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgbGV0IGxhc3RUb3BvSWQgPSBjb21waWxlQ29uZGl0aW9uYWxFeHByZXNzaW9uKGl0ZW0udGVzdCwgY29tcGlsZUNvbnRleHQsIGV4Y2VwdGlvblN0YXJ0SWQpO1xuXG4gICAgICAgICAgICAgICAgbGV0IHRoZW5TdGFydElkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBleGNlcHRpb25TdGFydElkICsgJzp0aGVuJyk7XG4gICAgICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBsYXN0VG9wb0lkLCB0aGVuU3RhcnRJZCk7XG4gICAgICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCB0aGVuU3RhcnRJZCwgZXhjZXB0aW9uRW5kSWQpO1xuXG4gICAgICAgICAgICAgICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW2V4Y2VwdGlvbkVuZElkXSA9IEpzTGFuZy5hc3RJZihcbiAgICAgICAgICAgICAgICAgICAgZ2V0Q29kZVJlcHJlc2VudGF0aW9uT2YobGFzdFRvcG9JZCwgY29tcGlsZUNvbnRleHQpLFxuICAgICAgICAgICAgICAgICAgICBKc0xhbmcuYXN0QmxvY2sodHJhbnNsYXRlVGhlbkFzdChcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoZW5TdGFydElkLFxuICAgICAgICAgICAgICAgICAgICAgICAgZXhjZXB0aW9uRW5kSWQsXG4gICAgICAgICAgICAgICAgICAgICAgICBpdGVtLnRoZW4sIGNvbXBpbGVDb250ZXh0KSksXG4gICAgICAgICAgICAgICAgICAgIG51bGwsXG4gICAgICAgICAgICAgICAgICAgIGBSZXR1cm4gb24gZXhjZXB0aW9uICMke2l9YFxuICAgICAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgICAgICBhZGRDb2RlQmxvY2soY29tcGlsZUNvbnRleHQsIGV4Y2VwdGlvbkVuZElkLCB7XG4gICAgICAgICAgICAgICAgICAgIHR5cGU6IEFTVF9CTEtfRVhDRVBUSU9OX0lURU1cbiAgICAgICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgICAgIGxhc3RFeGNlcHRpb25JZCA9IGV4Y2VwdGlvbkVuZElkO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1VuZXhwZWN0ZWQuJyk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgbGFzdEV4Y2VwdGlvbklkLCBlbmRUb3BvSWQpO1xuXG4gICAgbGV0IHJldHVyblN0YXJ0VG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCAnJHJldHVybjp2YWx1ZScpO1xuICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgcmV0dXJuU3RhcnRUb3BvSWQsIGVuZFRvcG9JZCk7XG5cbiAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbZW5kVG9wb0lkXSA9IHRyYW5zbGF0ZVJldHVyblZhbHVlQXN0KHJldHVyblN0YXJ0VG9wb0lkLCBlbmRUb3BvSWQsIG9vbE5vZGUudmFsdWUsIGNvbXBpbGVDb250ZXh0KTtcblxuICAgIGFkZENvZGVCbG9jayhjb21waWxlQ29udGV4dCwgZW5kVG9wb0lkLCB7XG4gICAgICAgIHR5cGU6IEFTVF9CTEtfSU5URVJGQUNFX1JFVFVSTlxuICAgIH0pO1xuICAgIFxuICAgIHJldHVybiBlbmRUb3BvSWQ7XG59XG5cbmZ1bmN0aW9uIGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgbmFtZSkge1xuICAgIGlmIChjb21waWxlQ29udGV4dC50b3BvTm9kZXMuaGFzKG5hbWUpKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgVG9wbyBpZCBcIiR7bmFtZX1cIiBhbHJlYWR5IGNyZWF0ZWQuYCk7XG4gICAgfVxuXG4gICAgYXNzZXJ0OiAhY29tcGlsZUNvbnRleHQudG9wb1NvcnQuaGFzRGVwZW5kZW5jeShuYW1lKSwgJ0FscmVhZHkgaW4gdG9wb1NvcnQhJztcblxuICAgIGNvbXBpbGVDb250ZXh0LnRvcG9Ob2Rlcy5hZGQobmFtZSk7XG5cbiAgICBpZiAobmFtZSA9PT0gJycpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCk7XG4gICAgfVxuXG4gICAgcmV0dXJuIG5hbWU7XG59XG5cbmZ1bmN0aW9uIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgcHJldmlvdXNPcCwgY3VycmVudE9wKSB7XG4gICAgcHJlOiBwcmV2aW91c09wICE9PSBjdXJyZW50T3AsICdTZWxmIGRlcGVuZGluZyc7XG5cbiAgICBjb21waWxlQ29udGV4dC5sb2dnZXIuZGVidWcoY3VycmVudE9wICsgJyBcXHgxYlszM21kZXBlbmRzIG9uXFx4MWJbMG0gJyArIHByZXZpb3VzT3ApO1xuXG4gICAgaWYgKCFjb21waWxlQ29udGV4dC50b3BvTm9kZXMuaGFzKGN1cnJlbnRPcCkpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBUb3BvIGlkIFwiJHtjdXJyZW50T3B9XCIgbm90IGNyZWF0ZWQuYCk7XG4gICAgfVxuXG4gICAgY29tcGlsZUNvbnRleHQudG9wb1NvcnQuYWRkKHByZXZpb3VzT3AsIGN1cnJlbnRPcCk7XG59XG5cbmZ1bmN0aW9uIGFkZENvZGVCbG9jayhjb21waWxlQ29udGV4dCwgdG9wb0lkLCBibG9ja01ldGEpIHtcbiAgICBpZiAoISh0b3BvSWQgaW4gY29tcGlsZUNvbnRleHQuYXN0TWFwKSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEFTVCBub3QgZm91bmQgZm9yIGJsb2NrIHdpdGggdG9wb0lkOiAke3RvcG9JZH1gKTtcbiAgICB9XG5cbiAgICBjb21waWxlQ29udGV4dC5tYXBPZlRva2VuVG9NZXRhLnNldCh0b3BvSWQsIGJsb2NrTWV0YSk7XG5cbiAgICBjb21waWxlQ29udGV4dC5sb2dnZXIudmVyYm9zZShgQWRkaW5nICR7YmxvY2tNZXRhLnR5cGV9IFwiJHt0b3BvSWR9XCIgaW50byBzb3VyY2UgY29kZS5gKTtcbiAgICAvL2NvbXBpbGVDb250ZXh0LmxvZ2dlci5kZWJ1ZygnQVNUOlxcbicgKyBKU09OLnN0cmluZ2lmeShjb21waWxlQ29udGV4dC5hc3RNYXBbdG9wb0lkXSwgbnVsbCwgMikpO1xufVxuXG5mdW5jdGlvbiBnZXRDb2RlUmVwcmVzZW50YXRpb25PZih0b3BvSWQsIGNvbXBpbGVDb250ZXh0KSB7XG4gICAgbGV0IGxhc3RTb3VyY2VUeXBlID0gY29tcGlsZUNvbnRleHQubWFwT2ZUb2tlblRvTWV0YS5nZXQodG9wb0lkKTtcblxuICAgIGlmIChsYXN0U291cmNlVHlwZSAmJiAobGFzdFNvdXJjZVR5cGUudHlwZSA9PT0gQVNUX0JMS19QUk9DRVNTT1JfQ0FMTCB8fCBsYXN0U291cmNlVHlwZS50eXBlID09PSBBU1RfQkxLX0FDVElWQVRPUl9DQUxMKSkge1xuICAgICAgICAvL2ZvciBtb2RpZmllciwganVzdCB1c2UgdGhlIGZpbmFsIHJlc3VsdFxuICAgICAgICByZXR1cm4gSnNMYW5nLmFzdFZhclJlZihsYXN0U291cmNlVHlwZS50YXJnZXQsIHRydWUpO1xuICAgIH1cblxuICAgIGxldCBhc3QgPSBjb21waWxlQ29udGV4dC5hc3RNYXBbdG9wb0lkXTtcbiAgICBpZiAoYXN0LnR5cGUgPT09ICdNZW1iZXJFeHByZXNzaW9uJyAmJiBhc3Qub2JqZWN0Lm5hbWUgPT09ICdsYXRlc3QnKSB7XG4gICAgICAgIHJldHVybiBKc0xhbmcuYXN0Q29uZGl0aW9uYWwoXG4gICAgICAgICAgICBKc0xhbmcuYXN0Q2FsbCgnbGF0ZXN0Lmhhc093blByb3BlcnR5JywgWyBhc3QucHJvcGVydHkudmFsdWUgXSksIC8qKiB0ZXN0ICovXG4gICAgICAgICAgICBhc3QsIC8qKiBjb25zZXF1ZW50ICovXG4gICAgICAgICAgICB7IC4uLmFzdCwgb2JqZWN0OiB7IC4uLmFzdC5vYmplY3QsIG5hbWU6ICdleGlzdGluZycgfSB9XG4gICAgICAgICk7ICAgXG4gICAgfVxuXG4gICAgcmV0dXJuIGNvbXBpbGVDb250ZXh0LmFzdE1hcFt0b3BvSWRdO1xufVxuXG5mdW5jdGlvbiBjcmVhdGVDb21waWxlQ29udGV4dCh0YXJnZXROYW1lLCBsb2dnZXIsIHNoYXJlZENvbnRleHQpIHtcbiAgICBsZXQgY29tcGlsZUNvbnRleHQgPSB7XG4gICAgICAgIHRhcmdldE5hbWUsICAgICAgICBcbiAgICAgICAgbG9nZ2VyLFxuICAgICAgICB0b3BvTm9kZXM6IG5ldyBTZXQoKSxcbiAgICAgICAgdG9wb1NvcnQ6IG5ldyBUb3BvU29ydCgpLFxuICAgICAgICBhc3RNYXA6IHt9LCAvLyBTdG9yZSB0aGUgQVNUIGZvciBhIG5vZGVcbiAgICAgICAgbWFwT2ZUb2tlblRvTWV0YTogbmV3IE1hcCgpLCAvLyBTdG9yZSB0aGUgc291cmNlIGNvZGUgYmxvY2sgcG9pbnRcbiAgICAgICAgbW9kZWxWYXJzOiBuZXcgU2V0KCksXG4gICAgICAgIG1hcE9mRnVuY3RvclRvRmlsZTogKHNoYXJlZENvbnRleHQgJiYgc2hhcmVkQ29udGV4dC5tYXBPZkZ1bmN0b3JUb0ZpbGUpIHx8IHt9LCAvLyBVc2UgdG8gcmVjb3JkIGltcG9ydCBsaW5lc1xuICAgICAgICBuZXdGdW5jdG9yRmlsZXM6IChzaGFyZWRDb250ZXh0ICYmIHNoYXJlZENvbnRleHQubmV3RnVuY3RvckZpbGVzKSB8fCBbXVxuICAgIH07XG5cbiAgICBjb21waWxlQ29udGV4dC5tYWluU3RhcnRJZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgJyRtYWluJyk7XG5cbiAgICBsb2dnZXIudmVyYm9zZShgQ3JlYXRlZCBjb21waWxhdGlvbiBjb250ZXh0IGZvciBcIiR7dGFyZ2V0TmFtZX1cIi5gKTtcblxuICAgIHJldHVybiBjb21waWxlQ29udGV4dDtcbn1cblxuZnVuY3Rpb24gaXNUb3BMZXZlbEJsb2NrKHRvcG9JZCkge1xuICAgIHJldHVybiB0b3BvSWQuaW5kZXhPZignOmFyZ1snKSA9PT0gLTEgJiYgdG9wb0lkLmluZGV4T2YoJyRjYXNlc1snKSA9PT0gLTEgJiYgdG9wb0lkLmluZGV4T2YoJyRleGNlcHRpb25zWycpID09PSAtMTtcbn1cblxuZnVuY3Rpb24gcmVwbGFjZVZhclJlZlNjb3BlKHZhclJlZiwgdGFyZ2V0U2NvcGUpIHtcbiAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHZhclJlZikpIHtcbiAgICAgICAgYXNzZXJ0OiB2YXJSZWYub29sVHlwZSA9PT0gJ09iamVjdFJlZmVyZW5jZSc7XG5cbiAgICAgICAgcmV0dXJuIHsgb29sVHlwZTogJ09iamVjdFJlZmVyZW5jZScsIG5hbWU6IHJlcGxhY2VWYXJSZWZTY29wZSh2YXJSZWYubmFtZSwgdGFyZ2V0U2NvcGUpIH07ICAgICAgICBcbiAgICB9IFxuXG4gICAgYXNzZXJ0OiB0eXBlb2YgdmFyUmVmID09PSAnc3RyaW5nJztcblxuICAgIGxldCBwYXJ0cyA9IHZhclJlZi5zcGxpdCgnLicpO1xuICAgIGFzc2VydDogcGFydHMubGVuZ3RoID4gMTtcblxuICAgIHBhcnRzLnNwbGljZSgwLCAxLCB0YXJnZXRTY29wZSk7XG4gICAgcmV0dXJuIHBhcnRzLmpvaW4oJy4nKTtcbn1cblxubW9kdWxlLmV4cG9ydHMgPSB7XG4gICAgY29tcGlsZVBhcmFtLFxuICAgIGNvbXBpbGVGaWVsZCxcbiAgICBjb21waWxlRGJPcGVyYXRpb24sXG4gICAgY29tcGlsZUV4Y2VwdGlvbmFsUmV0dXJuLFxuICAgIGNvbXBpbGVSZXR1cm4sXG4gICAgY3JlYXRlVG9wb0lkLFxuICAgIGNyZWF0ZUNvbXBpbGVDb250ZXh0LFxuICAgIGRlcGVuZHNPbixcbiAgICBhZGRDb2RlQmxvY2ssXG5cbiAgICBBU1RfQkxLX0ZJRUxEX1BSRV9QUk9DRVNTLFxuICAgIEFTVF9CTEtfUFJPQ0VTU09SX0NBTEwsXG4gICAgQVNUX0JMS19WQUxJREFUT1JfQ0FMTCxcbiAgICBBU1RfQkxLX0FDVElWQVRPUl9DQUxMLFxuICAgIEFTVF9CTEtfVklFV19PUEVSQVRJT04sXG4gICAgQVNUX0JMS19WSUVXX1JFVFVSTixcbiAgICBBU1RfQkxLX0lOVEVSRkFDRV9PUEVSQVRJT04sXG4gICAgQVNUX0JMS19JTlRFUkZBQ0VfUkVUVVJOLCBcbiAgICBBU1RfQkxLX0VYQ0VQVElPTl9JVEVNLFxuXG4gICAgT09MX01PRElGSUVSX0NPREVfRkxBR1xufTsiXX0=