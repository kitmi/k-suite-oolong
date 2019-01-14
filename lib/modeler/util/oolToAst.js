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
      return JsLang.astThrow(then.errorType || defaultError, then.message || []);
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9tb2RlbGVyL3V0aWwvb29sVG9Bc3QuanMiXSwibmFtZXMiOlsiXyIsInJlcXVpcmUiLCJUb3BvU29ydCIsIkpzTGFuZyIsIk9vbFR5cGVzIiwiaXNEb3RTZXBhcmF0ZU5hbWUiLCJleHRyYWN0RG90U2VwYXJhdGVOYW1lIiwiZXh0cmFjdFJlZmVyZW5jZUJhc2VOYW1lIiwiT29sb25nVmFsaWRhdG9ycyIsIk9vbG9uZ1Byb2Nlc3NvcnMiLCJPb2xvbmdBY3RpdmF0b3JzIiwiVHlwZXMiLCJkZWZhdWx0RXJyb3IiLCJBU1RfQkxLX0ZJRUxEX1BSRV9QUk9DRVNTIiwiQVNUX0JMS19QQVJBTV9TQU5JVElaRSIsIkFTVF9CTEtfUFJPQ0VTU09SX0NBTEwiLCJBU1RfQkxLX1ZBTElEQVRPUl9DQUxMIiwiQVNUX0JMS19BQ1RJVkFUT1JfQ0FMTCIsIkFTVF9CTEtfVklFV19PUEVSQVRJT04iLCJBU1RfQkxLX1ZJRVdfUkVUVVJOIiwiQVNUX0JMS19JTlRFUkZBQ0VfT1BFUkFUSU9OIiwiQVNUX0JMS19JTlRFUkZBQ0VfUkVUVVJOIiwiQVNUX0JMS19FWENFUFRJT05fSVRFTSIsIk9PTF9NT0RJRklFUl9DT0RFX0ZMQUciLCJNb2RpZmllciIsIlZBTElEQVRPUiIsIlBST0NFU1NPUiIsIkFDVElWQVRPUiIsIk9PTF9NT0RJRklFUl9PUCIsIk9PTF9NT0RJRklFUl9QQVRIIiwiT09MX01PRElGSUVSX0JVSUxUSU4iLCJjb21waWxlQ29uZGl0aW9uYWxFeHByZXNzaW9uIiwidGVzdCIsImNvbXBpbGVDb250ZXh0Iiwic3RhcnRUb3BvSWQiLCJpc1BsYWluT2JqZWN0Iiwib29sVHlwZSIsImVuZFRvcG9JZCIsImNyZWF0ZVRvcG9JZCIsIm9wZXJhbmRUb3BvSWQiLCJkZXBlbmRzT24iLCJsYXN0T3BlcmFuZFRvcG9JZCIsImNvbXBpbGVDb25jcmV0ZVZhbHVlRXhwcmVzc2lvbiIsImNhbGxlciIsImFzdEFyZ3VtZW50IiwiZ2V0Q29kZVJlcHJlc2VudGF0aW9uT2YiLCJyZXRUb3BvSWQiLCJjb21waWxlQWRIb2NWYWxpZGF0b3IiLCJjYWxsZWUiLCJvcCIsIm9wZXJhdG9yIiwiRXJyb3IiLCJsZWZ0VG9wb0lkIiwicmlnaHRUb3BvSWQiLCJsYXN0TGVmdElkIiwibGVmdCIsImxhc3RSaWdodElkIiwicmlnaHQiLCJhc3RNYXAiLCJhc3RCaW5FeHAiLCJhcmd1bWVudCIsImFzdE5vdCIsImFzdENhbGwiLCJ2YWx1ZVN0YXJ0VG9wb0lkIiwiYXN0VmFsdWUiLCJ0b3BvSWQiLCJ2YWx1ZSIsImZ1bmN0b3IiLCJjYWxsQXJncyIsImFyZ3MiLCJ0cmFuc2xhdGVBcmdzIiwiYXJnMCIsIm5hbWUiLCJjb25jYXQiLCJjb21waWxlTW9kaWZpZXIiLCJkZWNsYXJlUGFyYW1zIiwidHJhbnNsYXRlRnVuY3Rpb25QYXJhbXMiLCJpc0VtcHR5IiwiZnVuY3RvcklkIiwidHJhbnNsYXRlTW9kaWZpZXIiLCJyZWZlcmVuY2VzIiwiZXh0cmFjdFJlZmVyZW5jZWRGaWVsZHMiLCJmaW5kIiwicmVmIiwiaXNUb3BMZXZlbEJsb2NrIiwic3RhcnRzV2l0aCIsImFzdENvbmRpdGlvbmFsIiwicmVwbGFjZVZhclJlZlNjb3BlIiwiYWRkQ29kZUJsb2NrIiwidHlwZSIsInRhcmdldCIsIm9vbEFyZ3MiLCJjYXN0QXJyYXkiLCJyZWZzIiwiZm9yRWFjaCIsImEiLCJyZXN1bHQiLCJjaGVja1JlZmVyZW5jZVRvRmllbGQiLCJwdXNoIiwib2JqIiwidW5kZWZpbmVkIiwiYWRkTW9kaWZpZXJUb01hcCIsImZ1bmN0b3JUeXBlIiwiZnVuY3RvckpzRmlsZSIsIm1hcE9mRnVuY3RvclRvRmlsZSIsImZ1bmN0aW9uTmFtZSIsImZpbGVOYW1lIiwibmFtZXMiLCJsZW5ndGgiLCJyZWZFbnRpdHlOYW1lIiwidXBwZXJGaXJzdCIsImJ1aWx0aW5zIiwidGFyZ2V0TmFtZSIsIm5ld0Z1bmN0b3JGaWxlcyIsImNvbXBpbGVQaXBlZFZhbHVlIiwidmFyT29sIiwibGFzdFRvcG9JZCIsIm1vZGlmaWVycyIsIm1vZGlmaWVyIiwibW9kaWZpZXJTdGFydFRvcG9JZCIsImNvbXBpbGVWYXJpYWJsZVJlZmVyZW5jZSIsImJhc2VOYW1lIiwib3RoZXJzIiwic3BsaXQiLCJTZXQiLCJ0cmFuc2xhdGVGdW5jdGlvblBhcmFtIiwiYXJnIiwiaSIsInBvcCIsInRvU3RyaW5nIiwibWFwIiwiY291bnQiLCJoYXMiLCJhZGQiLCJyZWZCYXNlIiwicmVzdCIsImRlcGVuZGVuY3kiLCJtb2RlbFZhcnMiLCJyZWZGaWVsZE5hbWUiLCJKU09OIiwic3RyaW5naWZ5IiwibWFwVmFsdWVzIiwidmFsdWVPZkVsZW1lbnQiLCJrZXkiLCJzaWQiLCJlaWQiLCJBcnJheSIsImlzQXJyYXkiLCJpbmRleCIsImVhY2giLCJhcmdUb3BvSWQiLCJjb21waWxlUGFyYW0iLCJwYXJhbSIsInR5cGVPYmplY3QiLCJzYW5pdGl6ZXJOYW1lIiwidG9VcHBlckNhc2UiLCJ2YXJSZWYiLCJhc3RWYXJSZWYiLCJjYWxsQXN0IiwiYXN0QXJyYXlBY2Nlc3MiLCJwcmVwYXJlVG9wb0lkIiwiYXN0QXNzaWduIiwibWFpblN0YXJ0SWQiLCJ3cmFwUGFyYW1SZWZlcmVuY2UiLCJyZWFkeVRvcG9JZCIsImNvbXBpbGVGaWVsZCIsInBhcmFtTmFtZSIsImNvbnRleHROYW1lIiwiT2JqZWN0IiwiYXNzaWduIiwidHJhbnNsYXRlVGhlbkFzdCIsInN0YXJ0SWQiLCJlbmRJZCIsInRoZW4iLCJhc3NpZ25UbyIsImFzdFRocm93IiwiZXJyb3JUeXBlIiwibWVzc2FnZSIsInRyYW5zbGF0ZVJldHVyblZhbHVlQXN0IiwidmFsdWVFbmRJZCIsImFzdFJldHVybiIsInZhbHVlVG9wb0lkIiwiY29tcGlsZVJldHVybiIsImNvbXBpbGVGaW5kT25lIiwib3BlcmF0aW9uIiwiY29uZGl0aW9uVmFyTmFtZSIsImFzdCIsImFzdFZhckRlY2xhcmUiLCJjb25kaXRpb24iLCJ0b3BvSWRQcmVmaXgiLCJsYXN0U3RhdGVtZW50IiwiZWxzZSIsImVsc2VTdGFydCIsImVsc2VFbmQiLCJpdGVtcyIsInJldmVyc2UiLCJpdGVtIiwiY2FzZVByZWZpeCIsImNhc2VUb3BvSWQiLCJjYXNlUmVzdWx0VmFyTmFtZSIsImFzdENhc2VUdGVtIiwibW9kZWwiLCJpZlN0YXJ0IiwiaWZFbmQiLCJhc3RJZiIsImFzdEJsb2NrIiwiYXN0QXdhaXQiLCJtb2RlbFRvcG9JZCIsImNvbXBpbGVEYk9wZXJhdGlvbiIsImNvbXBpbGVFeGNlcHRpb25hbFJldHVybiIsIm9vbE5vZGUiLCJsYXN0RXhjZXB0aW9uSWQiLCJleGNlcHRpb25zIiwiZXhjZXB0aW9uU3RhcnRJZCIsImV4Y2VwdGlvbkVuZElkIiwidGhlblN0YXJ0SWQiLCJyZXR1cm5TdGFydFRvcG9JZCIsInRvcG9Ob2RlcyIsInRvcG9Tb3J0IiwiaGFzRGVwZW5kZW5jeSIsInByZXZpb3VzT3AiLCJjdXJyZW50T3AiLCJsb2dnZXIiLCJkZWJ1ZyIsImJsb2NrTWV0YSIsIm1hcE9mVG9rZW5Ub01ldGEiLCJzZXQiLCJ2ZXJib3NlIiwibGFzdFNvdXJjZVR5cGUiLCJnZXQiLCJvYmplY3QiLCJwcm9wZXJ0eSIsImNyZWF0ZUNvbXBpbGVDb250ZXh0Iiwic2hhcmVkQ29udGV4dCIsIk1hcCIsImluZGV4T2YiLCJ0YXJnZXRTY29wZSIsInBhcnRzIiwic3BsaWNlIiwiam9pbiIsIm1vZHVsZSIsImV4cG9ydHMiXSwibWFwcGluZ3MiOiJBQUFBOzs7O0FBT0EsTUFBTTtBQUFFQSxFQUFBQTtBQUFGLElBQVFDLE9BQU8sQ0FBQyxVQUFELENBQXJCOztBQUNBLE1BQU07QUFBRUMsRUFBQUE7QUFBRixJQUFlRCxPQUFPLENBQUMscUJBQUQsQ0FBNUI7O0FBRUEsTUFBTUUsTUFBTSxHQUFHRixPQUFPLENBQUMsVUFBRCxDQUF0Qjs7QUFDQSxNQUFNRyxRQUFRLEdBQUdILE9BQU8sQ0FBQyxxQkFBRCxDQUF4Qjs7QUFDQSxNQUFNO0FBQUVJLEVBQUFBLGlCQUFGO0FBQXFCQyxFQUFBQSxzQkFBckI7QUFBNkNDLEVBQUFBO0FBQTdDLElBQTBF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QUFYLENBQVA7QUFDSDs7QUFFREMsTUFBTSxDQUFDQyxPQUFQLEdBQWlCO0FBQ2IxRixFQUFBQSxZQURhO0FBRWJjLEVBQUFBLFlBRmE7QUFHYjJDLEVBQUFBLGtCQUhhO0FBSWJDLEVBQUFBLHdCQUphO0FBS2IzQixFQUFBQSxhQUxhO0FBTWJoSixFQUFBQSxZQU5hO0FBT2JrTSxFQUFBQSxvQkFQYTtBQVFiaE0sRUFBQUEsU0FSYTtBQVNiZ0QsRUFBQUEsWUFUYTtBQVdiM0UsRUFBQUEseUJBWGE7QUFZYkUsRUFBQUEsc0JBWmE7QUFhYkMsRUFBQUEsc0JBYmE7QUFjYkMsRUFBQUEsc0JBZGE7QUFlYkMsRUFBQUEsc0JBZmE7QUFnQmJDLEVBQUFBLG1CQWhCYTtBQWlCYkMsRUFBQUEsMkJBakJhO0FBa0JiQyxFQUFBQSx3QkFsQmE7QUFtQmJDLEVBQUFBLHNCQW5CYTtBQXFCYkMsRUFBQUE7QUFyQmEsQ0FBakIiLCJzb3VyY2VzQ29udGVudCI6WyJcInVzZSBzdHJpY3RcIjtcblxuLyoqXG4gKiBAbW9kdWxlXG4gKiBAaWdub3JlXG4gKi9cblxuY29uc3QgeyBfIH0gPSByZXF1aXJlKCdyay11dGlscycpO1xuY29uc3QgeyBUb3BvU29ydCB9ID0gcmVxdWlyZSgnQGstc3VpdGUvYWxnb3JpdGhtcycpO1xuXG5jb25zdCBKc0xhbmcgPSByZXF1aXJlKCcuL2FzdC5qcycpO1xuY29uc3QgT29sVHlwZXMgPSByZXF1aXJlKCcuLi8uLi9sYW5nL09vbFR5cGVzJyk7XG5jb25zdCB7IGlzRG90U2VwYXJhdGVOYW1lLCBleHRyYWN0RG90U2VwYXJhdGVOYW1lLCBleHRyYWN0UmVmZXJlbmNlQmFzZU5hbWUgfSA9IHJlcXVpcmUoJy4uLy4uL2xhbmcvT29sVXRpbHMnKTtcbmNvbnN0IE9vbG9uZ1ZhbGlkYXRvcnMgPSByZXF1aXJlKCcuLi8uLi9ydW50aW1lL1ZhbGlkYXRvcnMnKTtcbmNvbnN0IE9vbG9uZ1Byb2Nlc3NvcnMgPSByZXF1aXJlKCcuLi8uLi9ydW50aW1lL1Byb2Nlc3NvcnMnKTtcbmNvbnN0IE9vbG9uZ0FjdGl2YXRvcnMgPSByZXF1aXJlKCcuLi8uLi9ydW50aW1lL0FjdGl2YXRvcnMnKTtcbmNvbnN0IFR5cGVzID0gcmVxdWlyZSgnLi4vLi4vcnVudGltZS90eXBlcycpO1xuXG5jb25zdCBkZWZhdWx0RXJyb3IgPSAnSW52YWxpZFJlcXVlc3QnO1xuXG5jb25zdCBBU1RfQkxLX0ZJRUxEX1BSRV9QUk9DRVNTID0gJ0ZpZWxkUHJlUHJvY2Vzcyc7XG5jb25zdCBBU1RfQkxLX1BBUkFNX1NBTklUSVpFID0gJ1BhcmFtZXRlclNhbml0aXplJztcbmNvbnN0IEFTVF9CTEtfUFJPQ0VTU09SX0NBTEwgPSAnUHJvY2Vzc29yQ2FsbCc7XG5jb25zdCBBU1RfQkxLX1ZBTElEQVRPUl9DQUxMID0gJ1ZhbGlkYXRvckNhbGwnO1xuY29uc3QgQVNUX0JMS19BQ1RJVkFUT1JfQ0FMTCA9ICdBY3RpdmF0b3JDYWxsJztcbmNvbnN0IEFTVF9CTEtfVklFV19PUEVSQVRJT04gPSAnVmlld09wZXJhdGlvbic7XG5jb25zdCBBU1RfQkxLX1ZJRVdfUkVUVVJOID0gJ1ZpZXdSZXR1cm4nO1xuY29uc3QgQVNUX0JMS19JTlRFUkZBQ0VfT1BFUkFUSU9OID0gJ0ludGVyZmFjZU9wZXJhdGlvbic7XG5jb25zdCBBU1RfQkxLX0lOVEVSRkFDRV9SRVRVUk4gPSAnSW50ZXJmYWNlUmV0dXJuJztcbmNvbnN0IEFTVF9CTEtfRVhDRVBUSU9OX0lURU0gPSAnRXhjZXB0aW9uSXRlbSc7XG5cbmNvbnN0IE9PTF9NT0RJRklFUl9DT0RFX0ZMQUcgPSB7XG4gICAgW09vbFR5cGVzLk1vZGlmaWVyLlZBTElEQVRPUl06IEFTVF9CTEtfVkFMSURBVE9SX0NBTEwsXG4gICAgW09vbFR5cGVzLk1vZGlmaWVyLlBST0NFU1NPUl06IEFTVF9CTEtfUFJPQ0VTU09SX0NBTEwsXG4gICAgW09vbFR5cGVzLk1vZGlmaWVyLkFDVElWQVRPUl06IEFTVF9CTEtfQUNUSVZBVE9SX0NBTExcbn07XG5cbmNvbnN0IE9PTF9NT0RJRklFUl9PUCA9IHtcbiAgICBbT29sVHlwZXMuTW9kaWZpZXIuVkFMSURBVE9SXTogJ34nLFxuICAgIFtPb2xUeXBlcy5Nb2RpZmllci5QUk9DRVNTT1JdOiAnfD4nLFxuICAgIFtPb2xUeXBlcy5Nb2RpZmllci5BQ1RJVkFUT1JdOiAnPScgXG59O1xuXG5jb25zdCBPT0xfTU9ESUZJRVJfUEFUSCA9IHtcbiAgICBbT29sVHlwZXMuTW9kaWZpZXIuVkFMSURBVE9SXTogJ3ZhbGlkYXRvcnMnLFxuICAgIFtPb2xUeXBlcy5Nb2RpZmllci5QUk9DRVNTT1JdOiAncHJvY2Vzc29ycycsXG4gICAgW09vbFR5cGVzLk1vZGlmaWVyLkFDVElWQVRPUl06ICdhY3RpdmF0b3JzJyBcbn07XG5cbmNvbnN0IE9PTF9NT0RJRklFUl9CVUlMVElOID0ge1xuICAgIFtPb2xUeXBlcy5Nb2RpZmllci5WQUxJREFUT1JdOiBPb2xvbmdWYWxpZGF0b3JzLFxuICAgIFtPb2xUeXBlcy5Nb2RpZmllci5QUk9DRVNTT1JdOiBPb2xvbmdQcm9jZXNzb3JzLFxuICAgIFtPb2xUeXBlcy5Nb2RpZmllci5BQ1RJVkFUT1JdOiBPb2xvbmdBY3RpdmF0b3JzIFxufTtcblxuLyoqXG4gKiBDb21waWxlIGEgY29uZGl0aW9uYWwgZXhwcmVzc2lvblxuICogQHBhcmFtIHtvYmplY3R9IHRlc3RcbiAqIEBwYXJhbSB7b2JqZWN0fSBjb21waWxlQ29udGV4dFxuICogQHByb3BlcnR5IHtzdHJpbmd9IGNvbXBpbGVDb250ZXh0LnRhcmdldE5hbWVcbiAqIEBwcm9wZXJ0eSB7VG9wb1NvcnR9IGNvbXBpbGVDb250ZXh0LnRvcG9Tb3J0XG4gKiBAcHJvcGVydHkge29iamVjdH0gY29tcGlsZUNvbnRleHQuYXN0TWFwIC0gVG9wbyBJZCB0byBhc3QgbWFwXG4gKiBAcGFyYW0ge3N0cmluZ30gc3RhcnRUb3BvSWRcbiAqIEByZXR1cm5zIHtzdHJpbmd9IFRvcG8gSWRcbiAqL1xuZnVuY3Rpb24gY29tcGlsZUNvbmRpdGlvbmFsRXhwcmVzc2lvbih0ZXN0LCBjb21waWxlQ29udGV4dCwgc3RhcnRUb3BvSWQpIHtcbiAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHRlc3QpKSB7ICAgICAgICBcbiAgICAgICAgaWYgKHRlc3Qub29sVHlwZSA9PT0gJ1ZhbGlkYXRlRXhwcmVzc2lvbicpIHtcbiAgICAgICAgICAgIGxldCBlbmRUb3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkICsgJyR2YWxpT3A6ZG9uZScpO1xuICAgICAgICAgICAgbGV0IG9wZXJhbmRUb3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkICsgJyR2YWxpT3AnKTtcblxuICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCwgb3BlcmFuZFRvcG9JZCk7XG5cbiAgICAgICAgICAgIGxldCBsYXN0T3BlcmFuZFRvcG9JZCA9IGNvbXBpbGVDb25jcmV0ZVZhbHVlRXhwcmVzc2lvbihvcGVyYW5kVG9wb0lkLCB0ZXN0LmNhbGxlciwgY29tcGlsZUNvbnRleHQpO1xuICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBsYXN0T3BlcmFuZFRvcG9JZCwgZW5kVG9wb0lkKTtcblxuICAgICAgICAgICAgbGV0IGFzdEFyZ3VtZW50ID0gZ2V0Q29kZVJlcHJlc2VudGF0aW9uT2YobGFzdE9wZXJhbmRUb3BvSWQsIGNvbXBpbGVDb250ZXh0KTtcblxuICAgICAgICAgICAgbGV0IHJldFRvcG9JZCA9IGNvbXBpbGVBZEhvY1ZhbGlkYXRvcihlbmRUb3BvSWQsIGFzdEFyZ3VtZW50LCB0ZXN0LmNhbGxlZSwgY29tcGlsZUNvbnRleHQpO1xuXG4gICAgICAgICAgICBhc3NlcnQ6IHJldFRvcG9JZCA9PT0gZW5kVG9wb0lkO1xuXG4gICAgICAgICAgICAvKlxuICAgICAgICAgICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW2VuZFRvcG9JZF0gPSBKc0xhbmcuYXN0Q2FsbCgnXy5pc0VtcHR5JywgYXN0QXJndW1lbnQpO1xuXG4gICAgICAgICAgICBzd2l0Y2ggKHRlc3Qub3BlcmF0b3IpIHtcbiAgICAgICAgICAgICAgICBjYXNlICdleGlzdHMnOlxuICAgICAgICAgICAgICAgICAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbZW5kVG9wb0lkXSA9IEpzTGFuZy5hc3ROb3QoSnNMYW5nLmFzdENhbGwoJ18uaXNFbXB0eScsIGFzdEFyZ3VtZW50KSk7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgY2FzZSAnaXMtbm90LW51bGwnOlxuICAgICAgICAgICAgICAgICAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbZW5kVG9wb0lkXSA9IEpzTGFuZy5hc3ROb3QoSnNMYW5nLmFzdENhbGwoJ18uaXNOaWwnLCBhc3RBcmd1bWVudCkpO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgICAgIGNhc2UgJ25vdC1leGlzdHMnOlxuICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgICAgICBjYXNlICdpcy1udWxsJzpcbiAgICAgICAgICAgICAgICAgICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW2VuZFRvcG9JZF0gPSBKc0xhbmcuYXN0Q2FsbCgnXy5pc05pbCcsIGFzdEFyZ3VtZW50KTtcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgICAgICBjYXNlICdub3QnOlxuICAgICAgICAgICAgICAgICAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbZW5kVG9wb0lkXSA9IEpzTGFuZy5hc3ROb3QoYXN0QXJndW1lbnQpO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5zdXBwb3J0ZWQgdGVzdCBvcGVyYXRvcjogJyArIHRlc3Qub3BlcmF0b3IpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgKi9cblxuICAgICAgICAgICAgcmV0dXJuIGVuZFRvcG9JZDtcblxuICAgICAgICB9IGVsc2UgaWYgKHRlc3Qub29sVHlwZSA9PT0gJ0xvZ2ljYWxFeHByZXNzaW9uJykge1xuICAgICAgICAgICAgbGV0IGVuZFRvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgc3RhcnRUb3BvSWQgKyAnJGxvcE9wOmRvbmUnKTtcblxuICAgICAgICAgICAgbGV0IG9wO1xuXG4gICAgICAgICAgICBzd2l0Y2ggKHRlc3Qub3BlcmF0b3IpIHtcbiAgICAgICAgICAgICAgICBjYXNlICdhbmQnOlxuICAgICAgICAgICAgICAgICAgICBvcCA9ICcmJic7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgY2FzZSAnb3InOlxuICAgICAgICAgICAgICAgICAgICBvcCA9ICd8fCc7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbnN1cHBvcnRlZCB0ZXN0IG9wZXJhdG9yOiAnICsgdGVzdC5vcGVyYXRvcik7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCBsZWZ0VG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCArICckbG9wT3A6bGVmdCcpO1xuICAgICAgICAgICAgbGV0IHJpZ2h0VG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCArICckbG9wT3A6cmlnaHQnKTtcblxuICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCwgbGVmdFRvcG9JZCk7XG4gICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkLCByaWdodFRvcG9JZCk7XG5cbiAgICAgICAgICAgIGxldCBsYXN0TGVmdElkID0gY29tcGlsZUNvbmRpdGlvbmFsRXhwcmVzc2lvbih0ZXN0LmxlZnQsIGNvbXBpbGVDb250ZXh0LCBsZWZ0VG9wb0lkKTtcbiAgICAgICAgICAgIGxldCBsYXN0UmlnaHRJZCA9IGNvbXBpbGVDb25kaXRpb25hbEV4cHJlc3Npb24odGVzdC5yaWdodCwgY29tcGlsZUNvbnRleHQsIHJpZ2h0VG9wb0lkKTtcblxuICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBsYXN0TGVmdElkLCBlbmRUb3BvSWQpO1xuICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBsYXN0UmlnaHRJZCwgZW5kVG9wb0lkKTtcblxuICAgICAgICAgICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW2VuZFRvcG9JZF0gPSBKc0xhbmcuYXN0QmluRXhwKFxuICAgICAgICAgICAgICAgIGdldENvZGVSZXByZXNlbnRhdGlvbk9mKGxhc3RMZWZ0SWQsIGNvbXBpbGVDb250ZXh0KSxcbiAgICAgICAgICAgICAgICBvcCxcbiAgICAgICAgICAgICAgICBnZXRDb2RlUmVwcmVzZW50YXRpb25PZihsYXN0UmlnaHRJZCwgY29tcGlsZUNvbnRleHQpXG4gICAgICAgICAgICApOyBcblxuICAgICAgICAgICAgcmV0dXJuIGVuZFRvcG9JZDtcblxuICAgICAgICB9IGVsc2UgaWYgKHRlc3Qub29sVHlwZSA9PT0gJ0JpbmFyeUV4cHJlc3Npb24nKSB7XG4gICAgICAgICAgICBsZXQgZW5kVG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCArICckYmluT3A6ZG9uZScpO1xuXG4gICAgICAgICAgICBsZXQgb3A7XG5cbiAgICAgICAgICAgIHN3aXRjaCAodGVzdC5vcGVyYXRvcikge1xuICAgICAgICAgICAgICAgIGNhc2UgJz4nOlxuICAgICAgICAgICAgICAgIGNhc2UgJzwnOlxuICAgICAgICAgICAgICAgIGNhc2UgJz49JzpcbiAgICAgICAgICAgICAgICBjYXNlICc8PSc6XG4gICAgICAgICAgICAgICAgY2FzZSAnaW4nOlxuICAgICAgICAgICAgICAgICAgICBvcCA9IHRlc3Qub3BlcmF0b3I7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgY2FzZSAnPT0nOlxuICAgICAgICAgICAgICAgICAgICBvcCA9ICc9PT0nO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgICAgIGNhc2UgJyE9JzpcbiAgICAgICAgICAgICAgICAgICAgb3AgPSAnIT09JztcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1Vuc3VwcG9ydGVkIHRlc3Qgb3BlcmF0b3I6ICcgKyB0ZXN0Lm9wZXJhdG9yKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IGxlZnRUb3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkICsgJyRiaW5PcDpsZWZ0Jyk7XG4gICAgICAgICAgICBsZXQgcmlnaHRUb3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkICsgJyRiaW5PcDpyaWdodCcpO1xuXG4gICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkLCBsZWZ0VG9wb0lkKTtcbiAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgc3RhcnRUb3BvSWQsIHJpZ2h0VG9wb0lkKTtcblxuICAgICAgICAgICAgbGV0IGxhc3RMZWZ0SWQgPSBjb21waWxlQ29uY3JldGVWYWx1ZUV4cHJlc3Npb24obGVmdFRvcG9JZCwgdGVzdC5sZWZ0LCBjb21waWxlQ29udGV4dCk7XG4gICAgICAgICAgICBsZXQgbGFzdFJpZ2h0SWQgPSBjb21waWxlQ29uY3JldGVWYWx1ZUV4cHJlc3Npb24ocmlnaHRUb3BvSWQsIHRlc3QucmlnaHQsIGNvbXBpbGVDb250ZXh0KTtcblxuICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBsYXN0TGVmdElkLCBlbmRUb3BvSWQpO1xuICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBsYXN0UmlnaHRJZCwgZW5kVG9wb0lkKTtcblxuICAgICAgICAgICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW2VuZFRvcG9JZF0gPSBKc0xhbmcuYXN0QmluRXhwKFxuICAgICAgICAgICAgICAgIGdldENvZGVSZXByZXNlbnRhdGlvbk9mKGxhc3RMZWZ0SWQsIGNvbXBpbGVDb250ZXh0KSxcbiAgICAgICAgICAgICAgICBvcCxcbiAgICAgICAgICAgICAgICBnZXRDb2RlUmVwcmVzZW50YXRpb25PZihsYXN0UmlnaHRJZCwgY29tcGlsZUNvbnRleHQpXG4gICAgICAgICAgICApOyBcblxuICAgICAgICAgICAgcmV0dXJuIGVuZFRvcG9JZDtcblxuICAgICAgICB9IGVsc2UgaWYgKHRlc3Qub29sVHlwZSA9PT0gJ1VuYXJ5RXhwcmVzc2lvbicpIHtcbiAgICAgICAgICAgIGxldCBlbmRUb3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkICsgJyR1bmFPcDpkb25lJyk7XG4gICAgICAgICAgICBsZXQgb3BlcmFuZFRvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgc3RhcnRUb3BvSWQgKyAnJHVuYU9wJyk7XG5cbiAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgc3RhcnRUb3BvSWQsIG9wZXJhbmRUb3BvSWQpO1xuXG4gICAgICAgICAgICBsZXQgbGFzdE9wZXJhbmRUb3BvSWQgPSB0ZXN0Lm9wZXJhdG9yID09PSAnbm90JyA/IGNvbXBpbGVDb25jcmV0ZVZhbHVlRXhwcmVzc2lvbihvcGVyYW5kVG9wb0lkLCB0ZXN0LmFyZ3VtZW50LCBjb21waWxlQ29udGV4dCkgOiBjb21waWxlQ29uZGl0aW9uYWxFeHByZXNzaW9uKHRlc3QuYXJndW1lbnQsIGNvbXBpbGVDb250ZXh0LCBvcGVyYW5kVG9wb0lkKTtcbiAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgbGFzdE9wZXJhbmRUb3BvSWQsIGVuZFRvcG9JZCk7XG5cbiAgICAgICAgICAgIGxldCBhc3RBcmd1bWVudCA9IGdldENvZGVSZXByZXNlbnRhdGlvbk9mKGxhc3RPcGVyYW5kVG9wb0lkLCBjb21waWxlQ29udGV4dCk7XG5cbiAgICAgICAgICAgIHN3aXRjaCAodGVzdC5vcGVyYXRvcikge1xuICAgICAgICAgICAgICAgIGNhc2UgJ2V4aXN0cyc6XG4gICAgICAgICAgICAgICAgICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtlbmRUb3BvSWRdID0gSnNMYW5nLmFzdE5vdChKc0xhbmcuYXN0Q2FsbCgnXy5pc0VtcHR5JywgYXN0QXJndW1lbnQpKTtcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgICAgICBjYXNlICdpcy1ub3QtbnVsbCc6XG4gICAgICAgICAgICAgICAgICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtlbmRUb3BvSWRdID0gSnNMYW5nLmFzdE5vdChKc0xhbmcuYXN0Q2FsbCgnXy5pc05pbCcsIGFzdEFyZ3VtZW50KSk7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgY2FzZSAnbm90LWV4aXN0cyc6XG4gICAgICAgICAgICAgICAgICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtlbmRUb3BvSWRdID0gSnNMYW5nLmFzdENhbGwoJ18uaXNFbXB0eScsIGFzdEFyZ3VtZW50KTtcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgICAgICBjYXNlICdpcy1udWxsJzpcbiAgICAgICAgICAgICAgICAgICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW2VuZFRvcG9JZF0gPSBKc0xhbmcuYXN0Q2FsbCgnXy5pc05pbCcsIGFzdEFyZ3VtZW50KTtcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgICAgICBjYXNlICdub3QnOlxuICAgICAgICAgICAgICAgICAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbZW5kVG9wb0lkXSA9IEpzTGFuZy5hc3ROb3QoYXN0QXJndW1lbnQpO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5zdXBwb3J0ZWQgdGVzdCBvcGVyYXRvcjogJyArIHRlc3Qub3BlcmF0b3IpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gZW5kVG9wb0lkO1xuXG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBsZXQgdmFsdWVTdGFydFRvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgc3RhcnRUb3BvSWQgKyAnJHZhbHVlJyk7XG4gICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkLCB2YWx1ZVN0YXJ0VG9wb0lkKTtcbiAgICAgICAgICAgIHJldHVybiBjb21waWxlQ29uY3JldGVWYWx1ZUV4cHJlc3Npb24odmFsdWVTdGFydFRvcG9JZCwgdGVzdCwgY29tcGlsZUNvbnRleHQpO1xuICAgICAgICB9IFxuICAgIH1cblxuICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtzdGFydFRvcG9JZF0gPSBKc0xhbmcuYXN0VmFsdWUodGVzdCk7XG4gICAgcmV0dXJuIHN0YXJ0VG9wb0lkO1xufVxuXG4vKipcbiAqIENvbXBpbGUgYSB2YWxpZGF0b3IgY2FsbGVkIGluIGEgbG9naWNhbCBleHByZXNzaW9uLlxuICogQHBhcmFtIHZhbHVlXG4gKiBAcGFyYW0gZnVuY3RvcnNcbiAqIEBwYXJhbSBjb21waWxlQ29udGV4dFxuICogQHBhcmFtIHRvcG9JbmZvXG4gKiBAcHJvcGVydHkge3N0cmluZ30gdG9wb0luZm8udG9wb0lkUHJlZml4XG4gKiBAcHJvcGVydHkge3N0cmluZ30gdG9wb0luZm8ubGFzdFRvcG9JZFxuICogQHJldHVybnMgeyp8c3RyaW5nfVxuICovXG5mdW5jdGlvbiBjb21waWxlQWRIb2NWYWxpZGF0b3IodG9wb0lkLCB2YWx1ZSwgZnVuY3RvciwgY29tcGlsZUNvbnRleHQpIHtcbiAgICBhc3NlcnQ6IGZ1bmN0b3Iub29sVHlwZSA9PT0gT29sVHlwZXMuTW9kaWZpZXIuVkFMSURBVE9SOyAgICAgICAgXG5cbiAgICBsZXQgY2FsbEFyZ3M7XG4gICAgXG4gICAgaWYgKGZ1bmN0b3IuYXJncykge1xuICAgICAgICBjYWxsQXJncyA9IHRyYW5zbGF0ZUFyZ3ModG9wb0lkLCBmdW5jdG9yLmFyZ3MsIGNvbXBpbGVDb250ZXh0KTsgICAgICAgIFxuICAgIH0gZWxzZSB7XG4gICAgICAgIGNhbGxBcmdzID0gW107XG4gICAgfSAgICAgICAgICAgIFxuICAgIFxuICAgIGxldCBhcmcwID0gdmFsdWU7XG4gICAgXG4gICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW3RvcG9JZF0gPSBKc0xhbmcuYXN0Q2FsbCgnVmFsaWRhdG9ycy4nICsgZnVuY3Rvci5uYW1lLCBbIGFyZzAgXS5jb25jYXQoY2FsbEFyZ3MpKTtcblxuICAgIHJldHVybiB0b3BvSWQ7XG59XG5cbi8qKlxuICogQ29tcGlsZSBhIG1vZGlmaWVyIGZyb20gb29sIHRvIGFzdC5cbiAqIEBwYXJhbSB2YWx1ZVxuICogQHBhcmFtIGZ1bmN0b3JzXG4gKiBAcGFyYW0gY29tcGlsZUNvbnRleHRcbiAqIEBwYXJhbSB0b3BvSW5mb1xuICogQHByb3BlcnR5IHtzdHJpbmd9IHRvcG9JbmZvLnRvcG9JZFByZWZpeFxuICogQHByb3BlcnR5IHtzdHJpbmd9IHRvcG9JbmZvLmxhc3RUb3BvSWRcbiAqIEByZXR1cm5zIHsqfHN0cmluZ31cbiAqL1xuZnVuY3Rpb24gY29tcGlsZU1vZGlmaWVyKHRvcG9JZCwgdmFsdWUsIGZ1bmN0b3IsIGNvbXBpbGVDb250ZXh0KSB7XG4gICAgbGV0IGRlY2xhcmVQYXJhbXM7XG5cbiAgICBpZiAoZnVuY3Rvci5vb2xUeXBlID09PSBPb2xUeXBlcy5Nb2RpZmllci5BQ1RJVkFUT1IpIHsgXG4gICAgICAgIGRlY2xhcmVQYXJhbXMgPSB0cmFuc2xhdGVGdW5jdGlvblBhcmFtcyhmdW5jdG9yLmFyZ3MpOyAgICAgICAgXG4gICAgfSBlbHNlIHtcbiAgICAgICAgZGVjbGFyZVBhcmFtcyA9IHRyYW5zbGF0ZUZ1bmN0aW9uUGFyYW1zKF8uaXNFbXB0eShmdW5jdG9yLmFyZ3MpID8gW3ZhbHVlXSA6IFt2YWx1ZV0uY29uY2F0KGZ1bmN0b3IuYXJncykpOyAgICAgICAgXG4gICAgfSAgICAgICAgXG5cbiAgICBsZXQgZnVuY3RvcklkID0gdHJhbnNsYXRlTW9kaWZpZXIoZnVuY3RvciwgY29tcGlsZUNvbnRleHQsIGRlY2xhcmVQYXJhbXMpO1xuXG4gICAgbGV0IGNhbGxBcmdzLCByZWZlcmVuY2VzO1xuICAgIFxuICAgIGlmIChmdW5jdG9yLmFyZ3MpIHtcbiAgICAgICAgY2FsbEFyZ3MgPSB0cmFuc2xhdGVBcmdzKHRvcG9JZCwgZnVuY3Rvci5hcmdzLCBjb21waWxlQ29udGV4dCk7XG4gICAgICAgIHJlZmVyZW5jZXMgPSBleHRyYWN0UmVmZXJlbmNlZEZpZWxkcyhmdW5jdG9yLmFyZ3MpO1xuXG4gICAgICAgIGlmIChfLmZpbmQocmVmZXJlbmNlcywgcmVmID0+IHJlZiA9PT0gdmFsdWUubmFtZSkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignQ2Fubm90IHVzZSB0aGUgdGFyZ2V0IGZpZWxkIGl0c2VsZiBhcyBhbiBhcmd1bWVudCBvZiBhIG1vZGlmaWVyLicpO1xuICAgICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgICAgY2FsbEFyZ3MgPSBbXTtcbiAgICB9ICAgICAgICBcbiAgICBcbiAgICBpZiAoZnVuY3Rvci5vb2xUeXBlID09PSBPb2xUeXBlcy5Nb2RpZmllci5BQ1RJVkFUT1IpIHsgICAgICAgICAgICBcbiAgICAgICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW3RvcG9JZF0gPSBKc0xhbmcuYXN0Q2FsbChmdW5jdG9ySWQsIGNhbGxBcmdzKTtcbiAgICB9IGVsc2Uge1xuICAgICAgICBsZXQgYXJnMCA9IHZhbHVlO1xuICAgICAgICBpZiAoIWlzVG9wTGV2ZWxCbG9jayh0b3BvSWQpICYmIF8uaXNQbGFpbk9iamVjdCh2YWx1ZSkgJiYgdmFsdWUub29sVHlwZSA9PT0gJ09iamVjdFJlZmVyZW5jZScgJiYgdmFsdWUubmFtZS5zdGFydHNXaXRoKCdsYXRlc3QuJykpIHtcbiAgICAgICAgICAgIC8vbGV0IGV4aXN0aW5nUmVmID0gICAgICAgICAgICBcbiAgICAgICAgICAgIGFyZzAgPSBKc0xhbmcuYXN0Q29uZGl0aW9uYWwoXG4gICAgICAgICAgICAgICAgSnNMYW5nLmFzdENhbGwoJ2xhdGVzdC5oYXNPd25Qcm9wZXJ0eScsIFsgZXh0cmFjdFJlZmVyZW5jZUJhc2VOYW1lKHZhbHVlLm5hbWUpIF0pLCAvKiogdGVzdCAqL1xuICAgICAgICAgICAgICAgIHZhbHVlLCAvKiogY29uc2VxdWVudCAqL1xuICAgICAgICAgICAgICAgIHJlcGxhY2VWYXJSZWZTY29wZSh2YWx1ZSwgJ2V4aXN0aW5nJylcbiAgICAgICAgICAgICk7ICBcbiAgICAgICAgfVxuICAgICAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbdG9wb0lkXSA9IEpzTGFuZy5hc3RDYWxsKGZ1bmN0b3JJZCwgWyBhcmcwIF0uY29uY2F0KGNhbGxBcmdzKSk7XG4gICAgfSAgICBcblxuICAgIGlmIChpc1RvcExldmVsQmxvY2sodG9wb0lkKSkge1xuICAgICAgICBhZGRDb2RlQmxvY2soY29tcGlsZUNvbnRleHQsIHRvcG9JZCwge1xuICAgICAgICAgICAgdHlwZTogT09MX01PRElGSUVSX0NPREVfRkxBR1tmdW5jdG9yLm9vbFR5cGVdLFxuICAgICAgICAgICAgdGFyZ2V0OiB2YWx1ZS5uYW1lLFxuICAgICAgICAgICAgcmVmZXJlbmNlczogcmVmZXJlbmNlcyAgIC8vIGxhdGVzdC4sIGV4c2l0aW5nLiwgcmF3LlxuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICByZXR1cm4gdG9wb0lkO1xufSAgXG4gICAgICBcbmZ1bmN0aW9uIGV4dHJhY3RSZWZlcmVuY2VkRmllbGRzKG9vbEFyZ3MpIHsgICBcbiAgICBvb2xBcmdzID0gXy5jYXN0QXJyYXkob29sQXJncyk7ICAgIFxuXG4gICAgbGV0IHJlZnMgPSBbXTtcblxuICAgIG9vbEFyZ3MuZm9yRWFjaChhID0+IHtcbiAgICAgICAgbGV0IHJlc3VsdCA9IGNoZWNrUmVmZXJlbmNlVG9GaWVsZChhKTtcbiAgICAgICAgaWYgKHJlc3VsdCkge1xuICAgICAgICAgICAgcmVmcy5wdXNoKHJlc3VsdCk7XG4gICAgICAgIH1cbiAgICB9KTtcblxuICAgIHJldHVybiByZWZzO1xufVxuXG5mdW5jdGlvbiBjaGVja1JlZmVyZW5jZVRvRmllbGQob2JqKSB7XG4gICAgaWYgKF8uaXNQbGFpbk9iamVjdChvYmopICYmIG9iai5vb2xUeXBlKSB7XG4gICAgICAgIGlmIChvYmoub29sVHlwZSA9PT0gJ1BpcGVkVmFsdWUnKSByZXR1cm4gY2hlY2tSZWZlcmVuY2VUb0ZpZWxkKG9iai52YWx1ZSk7XG4gICAgICAgIGlmIChvYmoub29sVHlwZSA9PT0gJ09iamVjdFJlZmVyZW5jZScpIHtcbiAgICAgICAgICAgIHJldHVybiBvYmoubmFtZTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHJldHVybiB1bmRlZmluZWQ7XG59XG5cbmZ1bmN0aW9uIGFkZE1vZGlmaWVyVG9NYXAoZnVuY3RvcklkLCBmdW5jdG9yVHlwZSwgZnVuY3RvckpzRmlsZSwgbWFwT2ZGdW5jdG9yVG9GaWxlKSB7XG4gICAgaWYgKG1hcE9mRnVuY3RvclRvRmlsZVtmdW5jdG9ySWRdICYmIG1hcE9mRnVuY3RvclRvRmlsZVtmdW5jdG9ySWRdICE9PSBmdW5jdG9ySnNGaWxlKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgQ29uZmxpY3Q6ICR7ZnVuY3RvclR5cGV9IG5hbWluZyBcIiR7ZnVuY3RvcklkfVwiIGNvbmZsaWN0cyFgKTtcbiAgICB9XG4gICAgbWFwT2ZGdW5jdG9yVG9GaWxlW2Z1bmN0b3JJZF0gPSBmdW5jdG9ySnNGaWxlO1xufVxuXG4vKipcbiAqIENoZWNrIHdoZXRoZXIgYSBmdW5jdG9yIGlzIHVzZXItZGVmaW5lZCBvciBidWlsdC1pblxuICogQHBhcmFtIGZ1bmN0b3JcbiAqIEBwYXJhbSBjb21waWxlQ29udGV4dFxuICogQHBhcmFtIGFyZ3MgLSBVc2VkIHRvIG1ha2UgdXAgdGhlIGZ1bmN0aW9uIHNpZ25hdHVyZVxuICogQHJldHVybnMge3N0cmluZ30gZnVuY3RvciBpZFxuICovXG5mdW5jdGlvbiB0cmFuc2xhdGVNb2RpZmllcihmdW5jdG9yLCBjb21waWxlQ29udGV4dCwgYXJncykge1xuICAgIGxldCBmdW5jdGlvbk5hbWUsIGZpbGVOYW1lLCBmdW5jdG9ySWQ7XG5cbiAgICAvL2V4dHJhY3QgdmFsaWRhdG9yIG5hbWluZyBhbmQgaW1wb3J0IGluZm9ybWF0aW9uXG4gICAgaWYgKGlzRG90U2VwYXJhdGVOYW1lKGZ1bmN0b3IubmFtZSkpIHtcbiAgICAgICAgbGV0IG5hbWVzID0gZXh0cmFjdERvdFNlcGFyYXRlTmFtZShmdW5jdG9yLm5hbWUpO1xuICAgICAgICBpZiAobmFtZXMubGVuZ3RoID4gMikge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdOb3Qgc3VwcG9ydGVkIHJlZmVyZW5jZSB0eXBlOiAnICsgZnVuY3Rvci5uYW1lKTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vcmVmZXJlbmNlIHRvIG90aGVyIGVudGl0eSBmaWxlXG4gICAgICAgIGxldCByZWZFbnRpdHlOYW1lID0gbmFtZXNbMF07XG4gICAgICAgIGZ1bmN0aW9uTmFtZSA9IG5hbWVzWzFdO1xuICAgICAgICBmaWxlTmFtZSA9ICcuLycgKyBPT0xfTU9ESUZJRVJfUEFUSFtmdW5jdG9yLm9vbFR5cGVdICsgJy8nICsgcmVmRW50aXR5TmFtZSArICctJyArIGZ1bmN0aW9uTmFtZSArICcuanMnO1xuICAgICAgICBmdW5jdG9ySWQgPSByZWZFbnRpdHlOYW1lICsgXy51cHBlckZpcnN0KGZ1bmN0aW9uTmFtZSk7XG4gICAgICAgIGFkZE1vZGlmaWVyVG9NYXAoZnVuY3RvcklkLCBmdW5jdG9yLm9vbFR5cGUsIGZpbGVOYW1lLCBjb21waWxlQ29udGV4dC5tYXBPZkZ1bmN0b3JUb0ZpbGUpO1xuXG4gICAgfSBlbHNlIHtcbiAgICAgICAgZnVuY3Rpb25OYW1lID0gZnVuY3Rvci5uYW1lO1xuXG4gICAgICAgIGxldCBidWlsdGlucyA9IE9PTF9NT0RJRklFUl9CVUlMVElOW2Z1bmN0b3Iub29sVHlwZV07XG5cbiAgICAgICAgaWYgKCEoZnVuY3Rpb25OYW1lIGluIGJ1aWx0aW5zKSkge1xuICAgICAgICAgICAgZmlsZU5hbWUgPSAnLi8nICsgT09MX01PRElGSUVSX1BBVEhbZnVuY3Rvci5vb2xUeXBlXSArICcvJyArIGNvbXBpbGVDb250ZXh0LnRhcmdldE5hbWUgKyAnLScgKyBmdW5jdGlvbk5hbWUgKyAnLmpzJztcbiAgICAgICAgICAgIGZ1bmN0b3JJZCA9IGZ1bmN0aW9uTmFtZTtcblxuICAgICAgICAgICAgaWYgKCFjb21waWxlQ29udGV4dC5tYXBPZkZ1bmN0b3JUb0ZpbGVbZnVuY3RvcklkXSkge1xuICAgICAgICAgICAgICAgIGNvbXBpbGVDb250ZXh0Lm5ld0Z1bmN0b3JGaWxlcy5wdXNoKHtcbiAgICAgICAgICAgICAgICAgICAgZnVuY3Rpb25OYW1lLFxuICAgICAgICAgICAgICAgICAgICBmdW5jdG9yVHlwZTogZnVuY3Rvci5vb2xUeXBlLFxuICAgICAgICAgICAgICAgICAgICBmaWxlTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgYXJnc1xuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBhZGRNb2RpZmllclRvTWFwKGZ1bmN0b3JJZCwgZnVuY3Rvci5vb2xUeXBlLCBmaWxlTmFtZSwgY29tcGlsZUNvbnRleHQubWFwT2ZGdW5jdG9yVG9GaWxlKTsgICAgICAgICAgICBcbiAgICAgICAgfSBlbHNlIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIGZ1bmN0b3JJZCA9IGZ1bmN0b3Iub29sVHlwZSArICdzLicgKyBmdW5jdGlvbk5hbWU7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICByZXR1cm4gZnVuY3RvcklkO1xufVxuXG4vKipcbiAqIENvbXBpbGUgYSBwaXBlZCB2YWx1ZSBmcm9tIG9vbCB0byBhc3QuXG4gKiBAcGFyYW0ge3N0cmluZ30gc3RhcnRUb3BvSWQgLSBUaGUgdG9wb2xvZ2ljYWwgaWQgb2YgdGhlIHN0YXJ0aW5nIHByb2Nlc3MgdG8gdGhlIHRhcmdldCB2YWx1ZSwgZGVmYXVsdCBhcyB0aGUgcGFyYW0gbmFtZVxuICogQHBhcmFtIHtvYmplY3R9IHZhck9vbCAtIFRhcmdldCB2YWx1ZSBvb2wgbm9kZS5cbiAqIEBwYXJhbSB7b2JqZWN0fSBjb21waWxlQ29udGV4dCAtIENvbXBpbGF0aW9uIGNvbnRleHQuXG4gKiBAcHJvcGVydHkge3N0cmluZ30gY29tcGlsZUNvbnRleHQudGFyZ2V0TmFtZVxuICogQHByb3BlcnR5IHtUb3BvU29ydH0gY29tcGlsZUNvbnRleHQudG9wb1NvcnRcbiAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBjb21waWxlQ29udGV4dC5hc3RNYXAgLSBUb3BvIElkIHRvIGFzdCBtYXBcbiAqIEByZXR1cm5zIHtzdHJpbmd9IExhc3QgdG9wbyBJZFxuICovXG5mdW5jdGlvbiBjb21waWxlUGlwZWRWYWx1ZShzdGFydFRvcG9JZCwgdmFyT29sLCBjb21waWxlQ29udGV4dCkge1xuICAgIGxldCBsYXN0VG9wb0lkID0gY29tcGlsZUNvbmNyZXRlVmFsdWVFeHByZXNzaW9uKHN0YXJ0VG9wb0lkLCB2YXJPb2wudmFsdWUsIGNvbXBpbGVDb250ZXh0KTtcblxuICAgIHZhck9vbC5tb2RpZmllcnMuZm9yRWFjaChtb2RpZmllciA9PiB7XG4gICAgICAgIGxldCBtb2RpZmllclN0YXJ0VG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCArIE9PTF9NT0RJRklFUl9PUFttb2RpZmllci5vb2xUeXBlXSArIG1vZGlmaWVyLm5hbWUpO1xuICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIGxhc3RUb3BvSWQsIG1vZGlmaWVyU3RhcnRUb3BvSWQpO1xuXG4gICAgICAgIGxhc3RUb3BvSWQgPSBjb21waWxlTW9kaWZpZXIoXG4gICAgICAgICAgICBtb2RpZmllclN0YXJ0VG9wb0lkLFxuICAgICAgICAgICAgdmFyT29sLnZhbHVlLFxuICAgICAgICAgICAgbW9kaWZpZXIsXG4gICAgICAgICAgICBjb21waWxlQ29udGV4dFxuICAgICAgICApO1xuICAgIH0pO1xuXG4gICAgcmV0dXJuIGxhc3RUb3BvSWQ7XG59XG5cbi8qKlxuICogQ29tcGlsZSBhIHZhcmlhYmxlIHJlZmVyZW5jZSBmcm9tIG9vbCB0byBhc3QuXG4gKiBAcGFyYW0ge3N0cmluZ30gc3RhcnRUb3BvSWQgLSBUaGUgdG9wb2xvZ2ljYWwgaWQgb2YgdGhlIHN0YXJ0aW5nIHByb2Nlc3MgdG8gdGhlIHRhcmdldCB2YWx1ZSwgZGVmYXVsdCBhcyB0aGUgcGFyYW0gbmFtZVxuICogQHBhcmFtIHtvYmplY3R9IHZhck9vbCAtIFRhcmdldCB2YWx1ZSBvb2wgbm9kZS5cbiAqIEBwYXJhbSB7b2JqZWN0fSBjb21waWxlQ29udGV4dCAtIENvbXBpbGF0aW9uIGNvbnRleHQuXG4gKiBAcHJvcGVydHkge3N0cmluZ30gY29tcGlsZUNvbnRleHQudGFyZ2V0TmFtZVxuICogQHByb3BlcnR5IHtUb3BvU29ydH0gY29tcGlsZUNvbnRleHQudG9wb1NvcnRcbiAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBjb21waWxlQ29udGV4dC5hc3RNYXAgLSBUb3BvIElkIHRvIGFzdCBtYXBcbiAqIEByZXR1cm5zIHtzdHJpbmd9IExhc3QgdG9wbyBJZFxuICovXG5mdW5jdGlvbiBjb21waWxlVmFyaWFibGVSZWZlcmVuY2Uoc3RhcnRUb3BvSWQsIHZhck9vbCwgY29tcGlsZUNvbnRleHQpIHtcbiAgICBwcmU6IF8uaXNQbGFpbk9iamVjdCh2YXJPb2wpICYmIHZhck9vbC5vb2xUeXBlID09PSAnT2JqZWN0UmVmZXJlbmNlJztcblxuICAgIGxldCBbIGJhc2VOYW1lLCBvdGhlcnMgXSA9IHZhck9vbC5uYW1lLnNwbGl0KCcuJywgMik7XG4gICAgLypcbiAgICBpZiAoY29tcGlsZUNvbnRleHQubW9kZWxWYXJzICYmIGNvbXBpbGVDb250ZXh0Lm1vZGVsVmFycy5oYXMoYmFzZU5hbWUpICYmIG90aGVycykge1xuICAgICAgICB2YXJPb2wubmFtZSA9IGJhc2VOYW1lICsgJy5kYXRhJyArICcuJyArIG90aGVycztcbiAgICB9Ki8gICAgXG5cbiAgICAvL3NpbXBsZSB2YWx1ZVxuICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtzdGFydFRvcG9JZF0gPSBKc0xhbmcuYXN0VmFsdWUodmFyT29sKTtcbiAgICByZXR1cm4gc3RhcnRUb3BvSWQ7XG59XG5cbi8qKlxuICogR2V0IGFuIGFycmF5IG9mIHBhcmFtZXRlciBuYW1lcy5cbiAqIEBwYXJhbSB7YXJyYXl9IGFyZ3MgLSBBbiBhcnJheSBvZiBhcmd1bWVudHMgaW4gb29sIHN5bnRheFxuICogQHJldHVybnMge2FycmF5fVxuICovXG5mdW5jdGlvbiB0cmFuc2xhdGVGdW5jdGlvblBhcmFtcyhhcmdzKSB7XG4gICAgaWYgKF8uaXNFbXB0eShhcmdzKSkgcmV0dXJuIFtdO1xuXG4gICAgbGV0IG5hbWVzID0gbmV3IFNldCgpO1xuXG4gICAgZnVuY3Rpb24gdHJhbnNsYXRlRnVuY3Rpb25QYXJhbShhcmcsIGkpIHtcbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChhcmcpKSB7XG4gICAgICAgICAgICBpZiAoYXJnLm9vbFR5cGUgPT09ICdQaXBlZFZhbHVlJykge1xuICAgICAgICAgICAgICAgIHJldHVybiB0cmFuc2xhdGVGdW5jdGlvblBhcmFtKGFyZy52YWx1ZSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChhcmcub29sVHlwZSA9PT0gJ09iamVjdFJlZmVyZW5jZScpIHtcbiAgICAgICAgICAgICAgICBpZiAoaXNEb3RTZXBhcmF0ZU5hbWUoYXJnLm5hbWUpKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBleHRyYWN0RG90U2VwYXJhdGVOYW1lKGFyZy5uYW1lKS5wb3AoKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIHJldHVybiBhcmcubmFtZTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiAncGFyYW0nICsgKGkgKyAxKS50b1N0cmluZygpO1xuICAgIH1cblxuICAgIHJldHVybiBfLm1hcChhcmdzLCAoYXJnLCBpKSA9PiB7XG4gICAgICAgIGxldCBiYXNlTmFtZSA9IHRyYW5zbGF0ZUZ1bmN0aW9uUGFyYW0oYXJnLCBpKTtcbiAgICAgICAgbGV0IG5hbWUgPSBiYXNlTmFtZTtcbiAgICAgICAgbGV0IGNvdW50ID0gMjtcbiAgICAgICAgXG4gICAgICAgIHdoaWxlIChuYW1lcy5oYXMobmFtZSkpIHtcbiAgICAgICAgICAgIG5hbWUgPSBiYXNlTmFtZSArIGNvdW50LnRvU3RyaW5nKCk7XG4gICAgICAgICAgICBjb3VudCsrO1xuICAgICAgICB9XG5cbiAgICAgICAgbmFtZXMuYWRkKG5hbWUpO1xuICAgICAgICByZXR1cm4gbmFtZTsgICAgICAgIFxuICAgIH0pO1xufVxuXG4vKipcbiAqIENvbXBpbGUgYSBjb25jcmV0ZSB2YWx1ZSBleHByZXNzaW9uIGZyb20gb29sIHRvIGFzdFxuICogQHBhcmFtIHtzdHJpbmd9IHN0YXJ0VG9wb0lkIC0gVGhlIHRvcG8gaWQgb2YgdGhlIHN0YXJ0aW5nIHByb2Nlc3MgdG8gdGhlIHRhcmdldCB2YWx1ZSBleHByZXNzaW9uXG4gKiBAcGFyYW0ge29iamVjdH0gdmFsdWUgLSBPb2wgbm9kZVxuICogQHBhcmFtIHtvYmplY3R9IGNvbXBpbGVDb250ZXh0IC0gQ29tcGlsYXRpb24gY29udGV4dFxuICogQHJldHVybnMge3N0cmluZ30gTGFzdCB0b3BvSWRcbiAqL1xuZnVuY3Rpb24gY29tcGlsZUNvbmNyZXRlVmFsdWVFeHByZXNzaW9uKHN0YXJ0VG9wb0lkLCB2YWx1ZSwgY29tcGlsZUNvbnRleHQpIHtcbiAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHZhbHVlKSkge1xuICAgICAgICBpZiAodmFsdWUub29sVHlwZSA9PT0gJ1BpcGVkVmFsdWUnKSB7XG4gICAgICAgICAgICByZXR1cm4gY29tcGlsZVBpcGVkVmFsdWUoc3RhcnRUb3BvSWQsIHZhbHVlLCBjb21waWxlQ29udGV4dCk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAodmFsdWUub29sVHlwZSA9PT0gJ09iamVjdFJlZmVyZW5jZScpIHtcbiAgICAgICAgICAgIGxldCBbIHJlZkJhc2UsIC4uLnJlc3QgXSA9IGV4dHJhY3REb3RTZXBhcmF0ZU5hbWUodmFsdWUubmFtZSk7XG5cbiAgICAgICAgICAgIGxldCBkZXBlbmRlbmN5O1xuXG4gICAgICAgICAgICBpZiAoY29tcGlsZUNvbnRleHQubW9kZWxWYXJzICYmIGNvbXBpbGVDb250ZXh0Lm1vZGVsVmFycy5oYXMocmVmQmFzZSkpIHtcbiAgICAgICAgICAgICAgICAvL3VzZXIsIHVzZXIucGFzc3dvcmQgb3IgdXNlci5kYXRhLnBhc3N3b3JkXG4gICAgICAgICAgICAgICAgZGVwZW5kZW5jeSA9IHJlZkJhc2U7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKHJlZkJhc2UgPT09ICdsYXRlc3QnICYmIHJlc3QubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgICAgIC8vbGF0ZXN0LnBhc3N3b3JkXG4gICAgICAgICAgICAgICAgbGV0IHJlZkZpZWxkTmFtZSA9IHJlc3QucG9wKCk7XG4gICAgICAgICAgICAgICAgaWYgKHJlZkZpZWxkTmFtZSAhPT0gc3RhcnRUb3BvSWQpIHtcbiAgICAgICAgICAgICAgICAgICAgZGVwZW5kZW5jeSA9IHJlZkZpZWxkTmFtZSArICc6cmVhZHknO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSBpZiAoXy5pc0VtcHR5KHJlc3QpKSB7XG4gICAgICAgICAgICAgICAgZGVwZW5kZW5jeSA9IHJlZkJhc2UgKyAnOnJlYWR5JztcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbnJlY29nbml6ZWQgb2JqZWN0IHJlZmVyZW5jZTogJyArIEpTT04uc3RyaW5naWZ5KHZhbHVlKSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChkZXBlbmRlbmN5KSB7XG4gICAgICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBkZXBlbmRlbmN5LCBzdGFydFRvcG9JZCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiBjb21waWxlVmFyaWFibGVSZWZlcmVuY2Uoc3RhcnRUb3BvSWQsIHZhbHVlLCBjb21waWxlQ29udGV4dCk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAodmFsdWUub29sVHlwZSA9PT0gJ1JlZ0V4cCcpIHtcbiAgICAgICAgICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtzdGFydFRvcG9JZF0gPSBKc0xhbmcuYXN0VmFsdWUodmFsdWUpO1xuICAgICAgICAgICAgLy9jb25zb2xlLmxvZyhjb21waWxlQ29udGV4dC5hc3RNYXBbc3RhcnRUb3BvSWRdKTtcbiAgICAgICAgICAgIC8vdGhyb3cgbmV3IEVycm9yKHN0YXJ0VG9wb0lkKTtcbiAgICAgICAgICAgIHJldHVybiBzdGFydFRvcG9JZDtcbiAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgdmFsdWUgPSBfLm1hcFZhbHVlcyh2YWx1ZSwgKHZhbHVlT2ZFbGVtZW50LCBrZXkpID0+IHsgXG4gICAgICAgICAgICBsZXQgc2lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCArICcuJyArIGtleSk7XG4gICAgICAgICAgICBsZXQgZWlkID0gY29tcGlsZUNvbmNyZXRlVmFsdWVFeHByZXNzaW9uKHNpZCwgdmFsdWVPZkVsZW1lbnQsIGNvbXBpbGVDb250ZXh0KTtcbiAgICAgICAgICAgIGlmIChzaWQgIT09IGVpZCkge1xuICAgICAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgZWlkLCBzdGFydFRvcG9JZCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gY29tcGlsZUNvbnRleHQuYXN0TWFwW2VpZF07XG4gICAgICAgIH0pO1xuICAgIH0gZWxzZSBpZiAoQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHtcbiAgICAgICAgdmFsdWUgPSBfLm1hcCh2YWx1ZSwgKHZhbHVlT2ZFbGVtZW50LCBpbmRleCkgPT4geyBcbiAgICAgICAgICAgIGxldCBzaWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkICsgJ1snICsgaW5kZXggKyAnXScpO1xuICAgICAgICAgICAgbGV0IGVpZCA9IGNvbXBpbGVDb25jcmV0ZVZhbHVlRXhwcmVzc2lvbihzaWQsIHZhbHVlT2ZFbGVtZW50LCBjb21waWxlQ29udGV4dCk7XG4gICAgICAgICAgICBpZiAoc2lkICE9PSBlaWQpIHtcbiAgICAgICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIGVpZCwgc3RhcnRUb3BvSWQpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtlaWRdO1xuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbc3RhcnRUb3BvSWRdID0gSnNMYW5nLmFzdFZhbHVlKHZhbHVlKTtcbiAgICByZXR1cm4gc3RhcnRUb3BvSWQ7XG59XG5cbi8qKlxuICogVHJhbnNsYXRlIGFuIGFycmF5IG9mIGZ1bmN0aW9uIGFyZ3VtZW50cyBmcm9tIG9vbCBpbnRvIGFzdC5cbiAqIEBwYXJhbSB0b3BvSWQgLSBUaGUgbW9kaWZpZXIgZnVuY3Rpb24gdG9wbyBcbiAqIEBwYXJhbSBhcmdzIC0gXG4gKiBAcGFyYW0gY29tcGlsZUNvbnRleHQgLSBcbiAqIEByZXR1cm5zIHtBcnJheX1cbiAqL1xuZnVuY3Rpb24gdHJhbnNsYXRlQXJncyh0b3BvSWQsIGFyZ3MsIGNvbXBpbGVDb250ZXh0KSB7XG4gICAgYXJncyA9IF8uY2FzdEFycmF5KGFyZ3MpO1xuICAgIGlmIChfLmlzRW1wdHkoYXJncykpIHJldHVybiBbXTtcblxuICAgIGxldCBjYWxsQXJncyA9IFtdO1xuXG4gICAgXy5lYWNoKGFyZ3MsIChhcmcsIGkpID0+IHsgICAgICAgICAgICAgICAgXG4gICAgICAgIGxldCBhcmdUb3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIHRvcG9JZCArICc6YXJnWycgKyAoaSsxKS50b1N0cmluZygpICsgJ10nKTtcbiAgICAgICAgbGV0IGxhc3RUb3BvSWQgPSBjb21waWxlQ29uY3JldGVWYWx1ZUV4cHJlc3Npb24oYXJnVG9wb0lkLCBhcmcsIGNvbXBpbGVDb250ZXh0KTtcblxuICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIGxhc3RUb3BvSWQsIHRvcG9JZCk7XG5cbiAgICAgICAgY2FsbEFyZ3MgPSBjYWxsQXJncy5jb25jYXQoXy5jYXN0QXJyYXkoZ2V0Q29kZVJlcHJlc2VudGF0aW9uT2YobGFzdFRvcG9JZCwgY29tcGlsZUNvbnRleHQpKSk7XG4gICAgfSk7XG5cbiAgICByZXR1cm4gY2FsbEFyZ3M7XG59XG5cbi8qKlxuICogQ29tcGlsZSBhIHBhcmFtIG9mIGludGVyZmFjZSBmcm9tIG9vbCBpbnRvIGFzdFxuICogQHBhcmFtIGluZGV4XG4gKiBAcGFyYW0gcGFyYW1cbiAqIEBwYXJhbSBjb21waWxlQ29udGV4dFxuICogQHJldHVybnMge3N0cmluZ31cbiAqL1xuZnVuY3Rpb24gY29tcGlsZVBhcmFtKGluZGV4LCBwYXJhbSwgY29tcGlsZUNvbnRleHQpIHtcbiAgICBsZXQgdHlwZSA9IHBhcmFtLnR5cGU7ICAgIFxuXG4gICAgbGV0IHR5cGVPYmplY3QgPSBUeXBlc1t0eXBlXTtcblxuICAgIGlmICghdHlwZU9iamVjdCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1Vua25vd24gZmllbGQgdHlwZTogJyArIHR5cGUpO1xuICAgIH1cblxuICAgIGxldCBzYW5pdGl6ZXJOYW1lID0gYFR5cGVzLiR7dHlwZS50b1VwcGVyQ2FzZSgpfS5zYW5pdGl6ZWA7XG5cbiAgICBsZXQgdmFyUmVmID0gSnNMYW5nLmFzdFZhclJlZihwYXJhbS5uYW1lKTtcbiAgICBsZXQgY2FsbEFzdCA9IEpzTGFuZy5hc3RDYWxsKHNhbml0aXplck5hbWUsIFt2YXJSZWYsIEpzTGFuZy5hc3RBcnJheUFjY2VzcygnJG1ldGEucGFyYW1zJywgaW5kZXgpLCBKc0xhbmcuYXN0VmFyUmVmKCd0aGlzLmRiLmkxOG4nKV0pO1xuXG4gICAgbGV0IHByZXBhcmVUb3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsICckcGFyYW1zOnNhbml0aXplWycgKyBpbmRleC50b1N0cmluZygpICsgJ10nKTtcbiAgICAvL2xldCBzYW5pdGl6ZVN0YXJ0aW5nO1xuXG4gICAgLy9pZiAoaW5kZXggPT09IDApIHtcbiAgICAgICAgLy9kZWNsYXJlICRzYW5pdGl6ZVN0YXRlIHZhcmlhYmxlIGZvciB0aGUgZmlyc3QgdGltZVxuICAgIC8vICAgIHNhbml0aXplU3RhcnRpbmcgPSBKc0xhbmcuYXN0VmFyRGVjbGFyZSh2YXJSZWYsIGNhbGxBc3QsIGZhbHNlLCBmYWxzZSwgYFNhbml0aXplIHBhcmFtIFwiJHtwYXJhbS5uYW1lfVwiYCk7XG4gICAgLy99IGVsc2Uge1xuICAgIC8vbGV0IHNhbml0aXplU3RhcnRpbmcgPSA7XG5cbiAgICAgICAgLy9sZXQgbGFzdFByZXBhcmVUb3BvSWQgPSAnJHBhcmFtczpzYW5pdGl6ZVsnICsgKGluZGV4IC0gMSkudG9TdHJpbmcoKSArICddJztcbiAgICAgICAgLy9kZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIGxhc3RQcmVwYXJlVG9wb0lkLCBwcmVwYXJlVG9wb0lkKTtcbiAgICAvL31cblxuICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtwcmVwYXJlVG9wb0lkXSA9IFtcbiAgICAgICAgSnNMYW5nLmFzdEFzc2lnbih2YXJSZWYsIGNhbGxBc3QsIGBTYW5pdGl6ZSBhcmd1bWVudCBcIiR7cGFyYW0ubmFtZX1cImApXG4gICAgXTtcblxuICAgIGFkZENvZGVCbG9jayhjb21waWxlQ29udGV4dCwgcHJlcGFyZVRvcG9JZCwge1xuICAgICAgICB0eXBlOiBBU1RfQkxLX1BBUkFNX1NBTklUSVpFXG4gICAgfSk7XG5cbiAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIHByZXBhcmVUb3BvSWQsIGNvbXBpbGVDb250ZXh0Lm1haW5TdGFydElkKTtcblxuICAgIGxldCB0b3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIHBhcmFtLm5hbWUpO1xuICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgY29tcGlsZUNvbnRleHQubWFpblN0YXJ0SWQsIHRvcG9JZCk7XG5cbiAgICBsZXQgdmFsdWUgPSB3cmFwUGFyYW1SZWZlcmVuY2UocGFyYW0ubmFtZSwgcGFyYW0pO1xuICAgIGxldCBlbmRUb3BvSWQgPSBjb21waWxlVmFyaWFibGVSZWZlcmVuY2UodG9wb0lkLCB2YWx1ZSwgY29tcGlsZUNvbnRleHQpO1xuXG4gICAgbGV0IHJlYWR5VG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCB0b3BvSWQgKyAnOnJlYWR5Jyk7XG4gICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBlbmRUb3BvSWQsIHJlYWR5VG9wb0lkKTtcblxuICAgIHJldHVybiByZWFkeVRvcG9JZDtcbn1cblxuLyoqXG4gKiBDb21waWxlIGEgbW9kZWwgZmllbGQgcHJlcHJvY2VzcyBpbmZvcm1hdGlvbiBpbnRvIGFzdC5cbiAqIEBwYXJhbSB7b2JqZWN0fSBwYXJhbSAtIEZpZWxkIGluZm9ybWF0aW9uXG4gKiBAcGFyYW0ge29iamVjdH0gY29tcGlsZUNvbnRleHQgLSBDb21waWxhdGlvbiBjb250ZXh0XG4gKiBAcmV0dXJucyB7c3RyaW5nfVxuICovXG5mdW5jdGlvbiBjb21waWxlRmllbGQocGFyYW1OYW1lLCBwYXJhbSwgY29tcGlsZUNvbnRleHQpIHtcbiAgICAvLyAxLiByZWZlcmVuY2UgdG8gdGhlIGxhdGVzdCBvYmplY3QgdGhhdCBpcyBwYXNzZWQgcXVhbGlmaWVyIGNoZWNrc1xuICAgIC8vIDIuIGlmIG1vZGlmaWVycyBleGlzdCwgd3JhcCB0aGUgcmVmIGludG8gYSBwaXBlZCB2YWx1ZVxuICAgIC8vIDMuIHByb2Nlc3MgdGhlIHJlZiAob3IgcGlwZWQgcmVmKSBhbmQgbWFyayBhcyBlbmRcbiAgICAvLyA0LiBidWlsZCBkZXBlbmRlbmNpZXM6IGxhdGVzdC5maWVsZCAtPiAuLi4gLT4gZmllbGQ6cmVhZHkgXG4gICAgbGV0IHRvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgcGFyYW1OYW1lKTtcbiAgICBsZXQgY29udGV4dE5hbWUgPSAnbGF0ZXN0LicgKyBwYXJhbU5hbWU7XG4gICAgLy9jb21waWxlQ29udGV4dC5hc3RNYXBbdG9wb0lkXSA9IEpzTGFuZy5hc3RWYXJSZWYoY29udGV4dE5hbWUsIHRydWUpO1xuXG4gICAgbGV0IHZhbHVlID0gd3JhcFBhcmFtUmVmZXJlbmNlKGNvbnRleHROYW1lLCBwYXJhbSk7ICAgIFxuICAgIGxldCBlbmRUb3BvSWQgPSBjb21waWxlQ29uY3JldGVWYWx1ZUV4cHJlc3Npb24odG9wb0lkLCB2YWx1ZSwgY29tcGlsZUNvbnRleHQpO1xuXG4gICAgbGV0IHJlYWR5VG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCB0b3BvSWQgKyAnOnJlYWR5Jyk7XG4gICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBlbmRUb3BvSWQsIHJlYWR5VG9wb0lkKTtcblxuICAgIHJldHVybiByZWFkeVRvcG9JZDtcbn1cblxuZnVuY3Rpb24gd3JhcFBhcmFtUmVmZXJlbmNlKG5hbWUsIHZhbHVlKSB7XG4gICAgbGV0IHJlZiA9IE9iamVjdC5hc3NpZ24oeyBvb2xUeXBlOiAnT2JqZWN0UmVmZXJlbmNlJywgbmFtZTogbmFtZSB9KTtcbiAgICBcbiAgICBpZiAoIV8uaXNFbXB0eSh2YWx1ZS5tb2RpZmllcnMpKSB7XG4gICAgICAgIHJldHVybiB7IG9vbFR5cGU6ICdQaXBlZFZhbHVlJywgdmFsdWU6IHJlZiwgbW9kaWZpZXJzOiB2YWx1ZS5tb2RpZmllcnMgfTtcbiAgICB9XG4gICAgXG4gICAgcmV0dXJuIHJlZjtcbn1cblxuLyoqXG4gKiBUcmFuc2xhdGUgYSB0aGVuIGNsYXVzZSBmcm9tIG9vbCBpbnRvIGFzdFxuICogQHBhcmFtIHtzdHJpbmd9IHN0YXJ0SWRcbiAqIEBwYXJhbSB7c3RyaW5nfSBlbmRJZFxuICogQHBhcmFtIHRoZW5cbiAqIEBwYXJhbSBjb21waWxlQ29udGV4dFxuICogQHBhcmFtIGFzc2lnblRvXG4gKiBAcmV0dXJucyB7b2JqZWN0fSBBU1Qgb2JqZWN0XG4gKi9cbmZ1bmN0aW9uIHRyYW5zbGF0ZVRoZW5Bc3Qoc3RhcnRJZCwgZW5kSWQsIHRoZW4sIGNvbXBpbGVDb250ZXh0LCBhc3NpZ25Ubykge1xuICAgIGlmIChfLmlzUGxhaW5PYmplY3QodGhlbikpIHtcbiAgICAgICAgaWYgKHRoZW4ub29sVHlwZSA9PT0gJ1Rocm93RXhwcmVzc2lvbicpIHtcbiAgICAgICAgICAgIHJldHVybiBKc0xhbmcuYXN0VGhyb3codGhlbi5lcnJvclR5cGUgfHwgZGVmYXVsdEVycm9yLCB0aGVuLm1lc3NhZ2UgfHwgW10pO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHRoZW4ub29sVHlwZSA9PT0gJ1JldHVybkV4cHJlc3Npb24nKSB7XG4gICAgICAgICAgICByZXR1cm4gdHJhbnNsYXRlUmV0dXJuVmFsdWVBc3Qoc3RhcnRJZCwgZW5kSWQsIHRoZW4udmFsdWUsIGNvbXBpbGVDb250ZXh0KTtcbiAgICAgICAgfSAgICAgICAgXG4gICAgfVxuXG4gICAgLy90aGVuIGV4cHJlc3Npb24gaXMgYW4gb29sb25nIGNvbmNyZXRlIHZhbHVlICAgIFxuICAgIGlmIChfLmlzQXJyYXkodGhlbikgfHwgXy5pc1BsYWluT2JqZWN0KHRoZW4pKSB7XG4gICAgICAgIGxldCB2YWx1ZUVuZElkID0gY29tcGlsZUNvbmNyZXRlVmFsdWVFeHByZXNzaW9uKHN0YXJ0SWQsIHRoZW4sIGNvbXBpbGVDb250ZXh0KTsgICAgXG4gICAgICAgIHRoZW4gPSBjb21waWxlQ29udGV4dC5hc3RNYXBbdmFsdWVFbmRJZF07IFxuICAgIH0gICBcblxuICAgIGlmICghYXNzaWduVG8pIHtcbiAgICAgICAgcmV0dXJuIEpzTGFuZy5hc3RSZXR1cm4odGhlbik7XG4gICAgfVxuXG4gICAgcmV0dXJuIEpzTGFuZy5hc3RBc3NpZ24oYXNzaWduVG8sIHRoZW4pO1xufVxuXG4vKipcbiAqIFRyYW5zbGF0ZSBhIHJldHVybiBjbGF1c2UgZnJvbSBvb2wgaW50byBhc3RcbiAqIEBwYXJhbSB7c3RyaW5nfSBzdGFydFRvcG9JZCAtIFRoZSB0b3BvIGlkIG9mIHRoZSBzdGFydGluZyBzdGF0ZSBvZiByZXR1cm4gY2xhdXNlXG4gKiBAcGFyYW0ge3N0cmluZ30gZW5kVG9wb0lkIC0gVGhlIHRvcG8gaWQgb2YgdGhlIGVuZGluZyBzdGF0ZSBvZiByZXR1cm4gY2xhdXNlXG4gKiBAcGFyYW0gdmFsdWVcbiAqIEBwYXJhbSBjb21waWxlQ29udGV4dFxuICogQHJldHVybnMge29iamVjdH0gQVNUIG9iamVjdFxuICovXG5mdW5jdGlvbiB0cmFuc2xhdGVSZXR1cm5WYWx1ZUFzdChzdGFydFRvcG9JZCwgZW5kVG9wb0lkLCB2YWx1ZSwgY29tcGlsZUNvbnRleHQpIHtcbiAgICBsZXQgdmFsdWVUb3BvSWQgPSBjb21waWxlQ29uY3JldGVWYWx1ZUV4cHJlc3Npb24oc3RhcnRUb3BvSWQsIHZhbHVlLCBjb21waWxlQ29udGV4dCk7XG4gICAgaWYgKHZhbHVlVG9wb0lkICE9PSBzdGFydFRvcG9JZCkge1xuICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIHZhbHVlVG9wb0lkLCBlbmRUb3BvSWQpO1xuICAgIH1cblxuICAgIHJldHVybiBKc0xhbmcuYXN0UmV0dXJuKGdldENvZGVSZXByZXNlbnRhdGlvbk9mKHZhbHVlVG9wb0lkLCBjb21waWxlQ29udGV4dCkpO1xufVxuXG4vKipcbiAqIENvbXBpbGUgYSByZXR1cm4gY2xhdXNlIGZyb20gb29sIGludG8gYXN0XG4gKiBAcGFyYW0ge3N0cmluZ30gc3RhcnRUb3BvSWQgLSBUaGUgdG9wbyBpZCBvZiB0aGUgc3RhcnRpbmcgcHJvY2VzcyB0byB0aGUgdGFyZ2V0IHZhbHVlIGV4cHJlc3Npb25cbiAqIEBwYXJhbSB2YWx1ZVxuICogQHBhcmFtIGNvbXBpbGVDb250ZXh0XG4gKiBAcmV0dXJucyB7b2JqZWN0fSBBU1Qgb2JqZWN0XG4gKi9cbmZ1bmN0aW9uIGNvbXBpbGVSZXR1cm4oc3RhcnRUb3BvSWQsIHZhbHVlLCBjb21waWxlQ29udGV4dCkge1xuICAgIGxldCBlbmRUb3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsICckcmV0dXJuJyk7XG4gICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCwgZW5kVG9wb0lkKTtcblxuICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtlbmRUb3BvSWRdID0gdHJhbnNsYXRlUmV0dXJuVmFsdWVBc3Qoc3RhcnRUb3BvSWQsIGVuZFRvcG9JZCwgdmFsdWUsIGNvbXBpbGVDb250ZXh0KTtcblxuICAgIGFkZENvZGVCbG9jayhjb21waWxlQ29udGV4dCwgZW5kVG9wb0lkLCB7XG4gICAgICAgIHR5cGU6IEFTVF9CTEtfVklFV19SRVRVUk5cbiAgICB9KTtcblxuICAgIHJldHVybiBlbmRUb3BvSWQ7XG59XG5cbi8qKlxuICogQ29tcGlsZSBhIGZpbmQgb25lIG9wZXJhdGlvbiBmcm9tIG9vbCBpbnRvIGFzdFxuICogQHBhcmFtIHtpbnR9IGluZGV4XG4gKiBAcGFyYW0ge29iamVjdH0gb3BlcmF0aW9uIC0gT29sIG5vZGVcbiAqIEBwYXJhbSB7b2JqZWN0fSBjb21waWxlQ29udGV4dCAtXG4gKiBAcGFyYW0ge3N0cmluZ30gZGVwZW5kZW5jeVxuICogQHJldHVybnMge3N0cmluZ30gbGFzdCB0b3BvSWRcbiAqL1xuZnVuY3Rpb24gY29tcGlsZUZpbmRPbmUoaW5kZXgsIG9wZXJhdGlvbiwgY29tcGlsZUNvbnRleHQsIGRlcGVuZGVuY3kpIHtcbiAgICBwcmU6IGRlcGVuZGVuY3k7XG5cbiAgICBsZXQgZW5kVG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCAnb3AkJyArIGluZGV4LnRvU3RyaW5nKCkpO1xuICAgIGxldCBjb25kaXRpb25WYXJOYW1lID0gZW5kVG9wb0lkICsgJyRjb25kaXRpb24nO1xuXG4gICAgbGV0IGFzdCA9IFtcbiAgICAgICAgSnNMYW5nLmFzdFZhckRlY2xhcmUoY29uZGl0aW9uVmFyTmFtZSlcbiAgICBdO1xuXG4gICAgYXNzZXJ0OiBvcGVyYXRpb24uY29uZGl0aW9uO1xuXG4gICAgaWYgKG9wZXJhdGlvbi5jb25kaXRpb24ub29sVHlwZSkge1xuICAgICAgICAvL3NwZWNpYWwgY29uZGl0aW9uXG5cbiAgICAgICAgaWYgKG9wZXJhdGlvbi5jb25kaXRpb24ub29sVHlwZSA9PT0gJ2Nhc2VzJykge1xuICAgICAgICAgICAgbGV0IHRvcG9JZFByZWZpeCA9IGVuZFRvcG9JZCArICckY2FzZXMnO1xuICAgICAgICAgICAgbGV0IGxhc3RTdGF0ZW1lbnQ7XG5cbiAgICAgICAgICAgIGlmIChvcGVyYXRpb24uY29uZGl0aW9uLmVsc2UpIHtcbiAgICAgICAgICAgICAgICBsZXQgZWxzZVN0YXJ0ID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCB0b3BvSWRQcmVmaXggKyAnOmVsc2UnKTtcbiAgICAgICAgICAgICAgICBsZXQgZWxzZUVuZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgdG9wb0lkUHJlZml4ICsgJzplbmQnKTtcbiAgICAgICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIGVsc2VTdGFydCwgZWxzZUVuZCk7XG4gICAgICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBlbHNlRW5kLCBlbmRUb3BvSWQpO1xuXG4gICAgICAgICAgICAgICAgbGFzdFN0YXRlbWVudCA9IHRyYW5zbGF0ZVRoZW5Bc3QoZWxzZVN0YXJ0LCBlbHNlRW5kLCBvcGVyYXRpb24uY29uZGl0aW9uLmVsc2UsIGNvbXBpbGVDb250ZXh0LCBjb25kaXRpb25WYXJOYW1lKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgbGFzdFN0YXRlbWVudCA9IEpzTGFuZy5hc3RUaHJvdygnU2VydmVyRXJyb3InLCAnVW5leHBlY3RlZCBzdGF0ZS4nKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKF8uaXNFbXB0eShvcGVyYXRpb24uY29uZGl0aW9uLml0ZW1zKSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignTWlzc2luZyBjYXNlIGl0ZW1zJyk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIF8ucmV2ZXJzZShvcGVyYXRpb24uY29uZGl0aW9uLml0ZW1zKS5mb3JFYWNoKChpdGVtLCBpKSA9PiB7XG4gICAgICAgICAgICAgICAgaWYgKGl0ZW0ub29sVHlwZSAhPT0gJ0NvbmRpdGlvbmFsU3RhdGVtZW50Jykge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ0ludmFsaWQgY2FzZSBpdGVtLicpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGkgPSBvcGVyYXRpb24uY29uZGl0aW9uLml0ZW1zLmxlbmd0aCAtIGkgLSAxO1xuXG4gICAgICAgICAgICAgICAgbGV0IGNhc2VQcmVmaXggPSB0b3BvSWRQcmVmaXggKyAnWycgKyBpLnRvU3RyaW5nKCkgKyAnXSc7XG4gICAgICAgICAgICAgICAgbGV0IGNhc2VUb3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIGNhc2VQcmVmaXgpO1xuICAgICAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgZGVwZW5kZW5jeSwgY2FzZVRvcG9JZCk7XG5cbiAgICAgICAgICAgICAgICBsZXQgY2FzZVJlc3VsdFZhck5hbWUgPSAnJCcgKyB0b3BvSWRQcmVmaXggKyAnXycgKyBpLnRvU3RyaW5nKCk7XG5cbiAgICAgICAgICAgICAgICBsZXQgbGFzdFRvcG9JZCA9IGNvbXBpbGVDb25kaXRpb25hbEV4cHJlc3Npb24oaXRlbS50ZXN0LCBjb21waWxlQ29udGV4dCwgY2FzZVRvcG9JZCk7XG4gICAgICAgICAgICAgICAgbGV0IGFzdENhc2VUdGVtID0gZ2V0Q29kZVJlcHJlc2VudGF0aW9uT2YobGFzdFRvcG9JZCwgY29tcGlsZUNvbnRleHQpO1xuXG4gICAgICAgICAgICAgICAgYXNzZXJ0OiAhQXJyYXkuaXNBcnJheShhc3RDYXNlVHRlbSksICdJbnZhbGlkIGNhc2UgaXRlbSBhc3QuJztcblxuICAgICAgICAgICAgICAgIGFzdENhc2VUdGVtID0gSnNMYW5nLmFzdFZhckRlY2xhcmUoY2FzZVJlc3VsdFZhck5hbWUsIGFzdENhc2VUdGVtLCB0cnVlLCBmYWxzZSwgYENvbmRpdGlvbiAke2l9IGZvciBmaW5kIG9uZSAke29wZXJhdGlvbi5tb2RlbH1gKTtcblxuICAgICAgICAgICAgICAgIGxldCBpZlN0YXJ0ID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBjYXNlUHJlZml4ICsgJzp0aGVuJyk7XG4gICAgICAgICAgICAgICAgbGV0IGlmRW5kID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBjYXNlUHJlZml4ICsgJzplbmQnKTtcbiAgICAgICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIGxhc3RUb3BvSWQsIGlmU3RhcnQpO1xuICAgICAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgaWZTdGFydCwgaWZFbmQpO1xuXG4gICAgICAgICAgICAgICAgbGFzdFN0YXRlbWVudCA9IFtcbiAgICAgICAgICAgICAgICAgICAgYXN0Q2FzZVR0ZW0sXG4gICAgICAgICAgICAgICAgICAgIEpzTGFuZy5hc3RJZihKc0xhbmcuYXN0VmFyUmVmKGNhc2VSZXN1bHRWYXJOYW1lKSwgSnNMYW5nLmFzdEJsb2NrKHRyYW5zbGF0ZVRoZW5Bc3QoaWZTdGFydCwgaWZFbmQsIGl0ZW0udGhlbiwgY29tcGlsZUNvbnRleHQsIGNvbmRpdGlvblZhck5hbWUpKSwgbGFzdFN0YXRlbWVudClcbiAgICAgICAgICAgICAgICBdO1xuICAgICAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgaWZFbmQsIGVuZFRvcG9JZCk7XG4gICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgYXN0ID0gYXN0LmNvbmNhdChfLmNhc3RBcnJheShsYXN0U3RhdGVtZW50KSk7XG4gICAgICAgIH1cblxuXG4gICAgfVxuXG4gICAgYXN0LnB1c2goXG4gICAgICAgIEpzTGFuZy5hc3RWYXJEZWNsYXJlKG9wZXJhdGlvbi5tb2RlbCwgSnNMYW5nLmFzdEF3YWl0KGB0aGlzLmZpbmRPbmVfYCwgSnNMYW5nLmFzdFZhclJlZihjb25kaXRpb25WYXJOYW1lKSkpXG4gICAgKTtcblxuICAgIGxldCBtb2RlbFRvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgb3BlcmF0aW9uLm1vZGVsKTtcbiAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIGVuZFRvcG9JZCwgbW9kZWxUb3BvSWQpO1xuICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtlbmRUb3BvSWRdID0gYXN0O1xuICAgIHJldHVybiBlbmRUb3BvSWQ7XG59XG5cbmZ1bmN0aW9uIGNvbXBpbGVEYk9wZXJhdGlvbihpbmRleCwgb3BlcmF0aW9uLCBjb21waWxlQ29udGV4dCwgZGVwZW5kZW5jeSkge1xuICAgIGxldCBsYXN0VG9wb0lkO1xuXG4gICAgc3dpdGNoIChvcGVyYXRpb24ub29sVHlwZSkge1xuICAgICAgICBjYXNlICdmaW5kT25lJzpcbiAgICAgICAgICAgIGxhc3RUb3BvSWQgPSBjb21waWxlRmluZE9uZShpbmRleCwgb3BlcmF0aW9uLCBjb21waWxlQ29udGV4dCwgZGVwZW5kZW5jeSk7XG4gICAgICAgICAgICBicmVhaztcblxuICAgICAgICBjYXNlICdmaW5kJzpcbiAgICAgICAgICAgIC8vcHJlcGFyZURiQ29ubmVjdGlvbihjb21waWxlQ29udGV4dCk7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ3RiaScpO1xuICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgY2FzZSAndXBkYXRlJzpcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcigndGJpJyk7XG4gICAgICAgICAgICAvL3ByZXBhcmVEYkNvbm5lY3Rpb24oY29tcGlsZUNvbnRleHQpO1xuICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgY2FzZSAnY3JlYXRlJzpcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcigndGJpJyk7XG4gICAgICAgICAgICAvL3ByZXBhcmVEYkNvbm5lY3Rpb24oY29tcGlsZUNvbnRleHQpO1xuICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgY2FzZSAnZGVsZXRlJzpcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcigndGJpJyk7XG4gICAgICAgICAgICAvL3ByZXBhcmVEYkNvbm5lY3Rpb24oY29tcGlsZUNvbnRleHQpO1xuICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgY2FzZSAnamF2YXNjcmlwdCc6XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ3RiaScpO1xuICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgY2FzZSAnYXNzaWdubWVudCc6XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ3RiaScpO1xuICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5zdXBwb3J0ZWQgb3BlcmF0aW9uIHR5cGU6ICcgKyBvcGVyYXRpb24udHlwZSk7XG4gICAgfVxuXG4gICAgYWRkQ29kZUJsb2NrKGNvbXBpbGVDb250ZXh0LCBsYXN0VG9wb0lkLCB7XG4gICAgICAgIHR5cGU6IEFTVF9CTEtfSU5URVJGQUNFX09QRVJBVElPTlxuICAgIH0pO1xuXG4gICAgcmV0dXJuIGxhc3RUb3BvSWQ7XG59XG5cbi8qKlxuICogQ29tcGlsZSBleGNlcHRpb25hbCByZXR1cm4gXG4gKiBAcGFyYW0ge29iamVjdH0gb29sTm9kZVxuICogQHBhcmFtIHtvYmplY3R9IGNvbXBpbGVDb250ZXh0XG4gKiBAcGFyYW0ge3N0cmluZ30gW2RlcGVuZGVuY3ldXG4gKiBAcmV0dXJucyB7c3RyaW5nfSBsYXN0IHRvcG9JZFxuICovXG5mdW5jdGlvbiBjb21waWxlRXhjZXB0aW9uYWxSZXR1cm4ob29sTm9kZSwgY29tcGlsZUNvbnRleHQsIGRlcGVuZGVuY3kpIHtcbiAgICBwcmU6IChfLmlzUGxhaW5PYmplY3Qob29sTm9kZSkgJiYgb29sTm9kZS5vb2xUeXBlID09PSAnUmV0dXJuRXhwcmVzc2lvbicpO1xuXG4gICAgbGV0IGVuZFRvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgJyRyZXR1cm4nKSwgbGFzdEV4Y2VwdGlvbklkID0gZGVwZW5kZW5jeTtcblxuICAgIGlmICghXy5pc0VtcHR5KG9vbE5vZGUuZXhjZXB0aW9ucykpIHtcbiAgICAgICAgb29sTm9kZS5leGNlcHRpb25zLmZvckVhY2goKGl0ZW0sIGkpID0+IHtcbiAgICAgICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QoaXRlbSkpIHtcbiAgICAgICAgICAgICAgICBpZiAoaXRlbS5vb2xUeXBlICE9PSAnQ29uZGl0aW9uYWxTdGF0ZW1lbnQnKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5zdXBwb3J0ZWQgZXhjZXB0aW9uYWwgdHlwZTogJyArIGl0ZW0ub29sVHlwZSk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgbGV0IGV4Y2VwdGlvblN0YXJ0SWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIGVuZFRvcG9JZCArICc6ZXhjZXB0WycgKyBpLnRvU3RyaW5nKCkgKyAnXScpO1xuICAgICAgICAgICAgICAgIGxldCBleGNlcHRpb25FbmRJZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgZW5kVG9wb0lkICsgJzpleGNlcHRbJyArIGkudG9TdHJpbmcoKSArICddOmRvbmUnKTtcbiAgICAgICAgICAgICAgICBpZiAobGFzdEV4Y2VwdGlvbklkKSB7XG4gICAgICAgICAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgbGFzdEV4Y2VwdGlvbklkLCBleGNlcHRpb25TdGFydElkKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBsZXQgbGFzdFRvcG9JZCA9IGNvbXBpbGVDb25kaXRpb25hbEV4cHJlc3Npb24oaXRlbS50ZXN0LCBjb21waWxlQ29udGV4dCwgZXhjZXB0aW9uU3RhcnRJZCk7XG5cbiAgICAgICAgICAgICAgICBsZXQgdGhlblN0YXJ0SWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIGV4Y2VwdGlvblN0YXJ0SWQgKyAnOnRoZW4nKTtcbiAgICAgICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIGxhc3RUb3BvSWQsIHRoZW5TdGFydElkKTtcbiAgICAgICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIHRoZW5TdGFydElkLCBleGNlcHRpb25FbmRJZCk7XG5cbiAgICAgICAgICAgICAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbZXhjZXB0aW9uRW5kSWRdID0gSnNMYW5nLmFzdElmKFxuICAgICAgICAgICAgICAgICAgICBnZXRDb2RlUmVwcmVzZW50YXRpb25PZihsYXN0VG9wb0lkLCBjb21waWxlQ29udGV4dCksXG4gICAgICAgICAgICAgICAgICAgIEpzTGFuZy5hc3RCbG9jayh0cmFuc2xhdGVUaGVuQXN0KFxuICAgICAgICAgICAgICAgICAgICAgICAgdGhlblN0YXJ0SWQsXG4gICAgICAgICAgICAgICAgICAgICAgICBleGNlcHRpb25FbmRJZCxcbiAgICAgICAgICAgICAgICAgICAgICAgIGl0ZW0udGhlbiwgY29tcGlsZUNvbnRleHQpKSxcbiAgICAgICAgICAgICAgICAgICAgbnVsbCxcbiAgICAgICAgICAgICAgICAgICAgYFJldHVybiBvbiBleGNlcHRpb24gIyR7aX1gXG4gICAgICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgICAgIGFkZENvZGVCbG9jayhjb21waWxlQ29udGV4dCwgZXhjZXB0aW9uRW5kSWQsIHtcbiAgICAgICAgICAgICAgICAgICAgdHlwZTogQVNUX0JMS19FWENFUFRJT05fSVRFTVxuICAgICAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICAgICAgbGFzdEV4Y2VwdGlvbklkID0gZXhjZXB0aW9uRW5kSWQ7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5leHBlY3RlZC4nKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBsYXN0RXhjZXB0aW9uSWQsIGVuZFRvcG9JZCk7XG5cbiAgICBsZXQgcmV0dXJuU3RhcnRUb3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsICckcmV0dXJuOnZhbHVlJyk7XG4gICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCByZXR1cm5TdGFydFRvcG9JZCwgZW5kVG9wb0lkKTtcblxuICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtlbmRUb3BvSWRdID0gdHJhbnNsYXRlUmV0dXJuVmFsdWVBc3QocmV0dXJuU3RhcnRUb3BvSWQsIGVuZFRvcG9JZCwgb29sTm9kZS52YWx1ZSwgY29tcGlsZUNvbnRleHQpO1xuXG4gICAgYWRkQ29kZUJsb2NrKGNvbXBpbGVDb250ZXh0LCBlbmRUb3BvSWQsIHtcbiAgICAgICAgdHlwZTogQVNUX0JMS19JTlRFUkZBQ0VfUkVUVVJOXG4gICAgfSk7XG4gICAgXG4gICAgcmV0dXJuIGVuZFRvcG9JZDtcbn1cblxuZnVuY3Rpb24gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBuYW1lKSB7XG4gICAgaWYgKGNvbXBpbGVDb250ZXh0LnRvcG9Ob2Rlcy5oYXMobmFtZSkpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBUb3BvIGlkIFwiJHtuYW1lfVwiIGFscmVhZHkgY3JlYXRlZC5gKTtcbiAgICB9XG5cbiAgICBhc3NlcnQ6ICFjb21waWxlQ29udGV4dC50b3BvU29ydC5oYXNEZXBlbmRlbmN5KG5hbWUpLCAnQWxyZWFkeSBpbiB0b3BvU29ydCEnO1xuXG4gICAgY29tcGlsZUNvbnRleHQudG9wb05vZGVzLmFkZChuYW1lKTtcblxuICAgIGlmIChuYW1lID09PSAnJykge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoKTtcbiAgICB9XG5cbiAgICByZXR1cm4gbmFtZTtcbn1cblxuZnVuY3Rpb24gZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBwcmV2aW91c09wLCBjdXJyZW50T3ApIHtcbiAgICBwcmU6IHByZXZpb3VzT3AgIT09IGN1cnJlbnRPcCwgJ1NlbGYgZGVwZW5kaW5nJztcblxuICAgIGNvbXBpbGVDb250ZXh0LmxvZ2dlci5kZWJ1ZyhjdXJyZW50T3AgKyAnIFxceDFiWzMzbWRlcGVuZHMgb25cXHgxYlswbSAnICsgcHJldmlvdXNPcCk7XG5cbiAgICBpZiAoIWNvbXBpbGVDb250ZXh0LnRvcG9Ob2Rlcy5oYXMoY3VycmVudE9wKSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFRvcG8gaWQgXCIke2N1cnJlbnRPcH1cIiBub3QgY3JlYXRlZC5gKTtcbiAgICB9XG5cbiAgICBjb21waWxlQ29udGV4dC50b3BvU29ydC5hZGQocHJldmlvdXNPcCwgY3VycmVudE9wKTtcbn1cblxuZnVuY3Rpb24gYWRkQ29kZUJsb2NrKGNvbXBpbGVDb250ZXh0LCB0b3BvSWQsIGJsb2NrTWV0YSkge1xuICAgIGlmICghKHRvcG9JZCBpbiBjb21waWxlQ29udGV4dC5hc3RNYXApKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgQVNUIG5vdCBmb3VuZCBmb3IgYmxvY2sgd2l0aCB0b3BvSWQ6ICR7dG9wb0lkfWApO1xuICAgIH1cblxuICAgIGNvbXBpbGVDb250ZXh0Lm1hcE9mVG9rZW5Ub01ldGEuc2V0KHRvcG9JZCwgYmxvY2tNZXRhKTtcblxuICAgIGNvbXBpbGVDb250ZXh0LmxvZ2dlci52ZXJib3NlKGBBZGRpbmcgJHtibG9ja01ldGEudHlwZX0gXCIke3RvcG9JZH1cIiBpbnRvIHNvdXJjZSBjb2RlLmApO1xuICAgIC8vY29tcGlsZUNvbnRleHQubG9nZ2VyLmRlYnVnKCdBU1Q6XFxuJyArIEpTT04uc3RyaW5naWZ5KGNvbXBpbGVDb250ZXh0LmFzdE1hcFt0b3BvSWRdLCBudWxsLCAyKSk7XG59XG5cbmZ1bmN0aW9uIGdldENvZGVSZXByZXNlbnRhdGlvbk9mKHRvcG9JZCwgY29tcGlsZUNvbnRleHQpIHtcbiAgICBsZXQgbGFzdFNvdXJjZVR5cGUgPSBjb21waWxlQ29udGV4dC5tYXBPZlRva2VuVG9NZXRhLmdldCh0b3BvSWQpO1xuXG4gICAgaWYgKGxhc3RTb3VyY2VUeXBlICYmIChsYXN0U291cmNlVHlwZS50eXBlID09PSBBU1RfQkxLX1BST0NFU1NPUl9DQUxMIHx8IGxhc3RTb3VyY2VUeXBlLnR5cGUgPT09IEFTVF9CTEtfQUNUSVZBVE9SX0NBTEwpKSB7XG4gICAgICAgIC8vZm9yIG1vZGlmaWVyLCBqdXN0IHVzZSB0aGUgZmluYWwgcmVzdWx0XG4gICAgICAgIHJldHVybiBKc0xhbmcuYXN0VmFyUmVmKGxhc3RTb3VyY2VUeXBlLnRhcmdldCwgdHJ1ZSk7XG4gICAgfVxuXG4gICAgbGV0IGFzdCA9IGNvbXBpbGVDb250ZXh0LmFzdE1hcFt0b3BvSWRdO1xuICAgIGlmIChhc3QudHlwZSA9PT0gJ01lbWJlckV4cHJlc3Npb24nICYmIGFzdC5vYmplY3QubmFtZSA9PT0gJ2xhdGVzdCcpIHtcbiAgICAgICAgcmV0dXJuIEpzTGFuZy5hc3RDb25kaXRpb25hbChcbiAgICAgICAgICAgIEpzTGFuZy5hc3RDYWxsKCdsYXRlc3QuaGFzT3duUHJvcGVydHknLCBbIGFzdC5wcm9wZXJ0eS52YWx1ZSBdKSwgLyoqIHRlc3QgKi9cbiAgICAgICAgICAgIGFzdCwgLyoqIGNvbnNlcXVlbnQgKi9cbiAgICAgICAgICAgIHsgLi4uYXN0LCBvYmplY3Q6IHsgLi4uYXN0Lm9iamVjdCwgbmFtZTogJ2V4aXN0aW5nJyB9IH1cbiAgICAgICAgKTsgICBcbiAgICB9XG5cbiAgICByZXR1cm4gY29tcGlsZUNvbnRleHQuYXN0TWFwW3RvcG9JZF07XG59XG5cbmZ1bmN0aW9uIGNyZWF0ZUNvbXBpbGVDb250ZXh0KHRhcmdldE5hbWUsIGxvZ2dlciwgc2hhcmVkQ29udGV4dCkge1xuICAgIGxldCBjb21waWxlQ29udGV4dCA9IHtcbiAgICAgICAgdGFyZ2V0TmFtZSwgICAgICAgIFxuICAgICAgICBsb2dnZXIsXG4gICAgICAgIHRvcG9Ob2RlczogbmV3IFNldCgpLFxuICAgICAgICB0b3BvU29ydDogbmV3IFRvcG9Tb3J0KCksXG4gICAgICAgIGFzdE1hcDoge30sIC8vIFN0b3JlIHRoZSBBU1QgZm9yIGEgbm9kZVxuICAgICAgICBtYXBPZlRva2VuVG9NZXRhOiBuZXcgTWFwKCksIC8vIFN0b3JlIHRoZSBzb3VyY2UgY29kZSBibG9jayBwb2ludFxuICAgICAgICBtb2RlbFZhcnM6IG5ldyBTZXQoKSxcbiAgICAgICAgbWFwT2ZGdW5jdG9yVG9GaWxlOiAoc2hhcmVkQ29udGV4dCAmJiBzaGFyZWRDb250ZXh0Lm1hcE9mRnVuY3RvclRvRmlsZSkgfHwge30sIC8vIFVzZSB0byByZWNvcmQgaW1wb3J0IGxpbmVzXG4gICAgICAgIG5ld0Z1bmN0b3JGaWxlczogKHNoYXJlZENvbnRleHQgJiYgc2hhcmVkQ29udGV4dC5uZXdGdW5jdG9yRmlsZXMpIHx8IFtdXG4gICAgfTtcblxuICAgIGNvbXBpbGVDb250ZXh0Lm1haW5TdGFydElkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCAnJG1haW4nKTtcblxuICAgIGxvZ2dlci52ZXJib3NlKGBDcmVhdGVkIGNvbXBpbGF0aW9uIGNvbnRleHQgZm9yIFwiJHt0YXJnZXROYW1lfVwiLmApO1xuXG4gICAgcmV0dXJuIGNvbXBpbGVDb250ZXh0O1xufVxuXG5mdW5jdGlvbiBpc1RvcExldmVsQmxvY2sodG9wb0lkKSB7XG4gICAgcmV0dXJuIHRvcG9JZC5pbmRleE9mKCc6YXJnWycpID09PSAtMSAmJiB0b3BvSWQuaW5kZXhPZignJGNhc2VzWycpID09PSAtMSAmJiB0b3BvSWQuaW5kZXhPZignJGV4Y2VwdGlvbnNbJykgPT09IC0xO1xufVxuXG5mdW5jdGlvbiByZXBsYWNlVmFyUmVmU2NvcGUodmFyUmVmLCB0YXJnZXRTY29wZSkge1xuICAgIGlmIChfLmlzUGxhaW5PYmplY3QodmFyUmVmKSkge1xuICAgICAgICBhc3NlcnQ6IHZhclJlZi5vb2xUeXBlID09PSAnT2JqZWN0UmVmZXJlbmNlJztcblxuICAgICAgICByZXR1cm4geyBvb2xUeXBlOiAnT2JqZWN0UmVmZXJlbmNlJywgbmFtZTogcmVwbGFjZVZhclJlZlNjb3BlKHZhclJlZi5uYW1lLCB0YXJnZXRTY29wZSkgfTsgICAgICAgIFxuICAgIH0gXG5cbiAgICBhc3NlcnQ6IHR5cGVvZiB2YXJSZWYgPT09ICdzdHJpbmcnO1xuXG4gICAgbGV0IHBhcnRzID0gdmFyUmVmLnNwbGl0KCcuJyk7XG4gICAgYXNzZXJ0OiBwYXJ0cy5sZW5ndGggPiAxO1xuXG4gICAgcGFydHMuc3BsaWNlKDAsIDEsIHRhcmdldFNjb3BlKTtcbiAgICByZXR1cm4gcGFydHMuam9pbignLicpO1xufVxuXG5tb2R1bGUuZXhwb3J0cyA9IHtcbiAgICBjb21waWxlUGFyYW0sXG4gICAgY29tcGlsZUZpZWxkLFxuICAgIGNvbXBpbGVEYk9wZXJhdGlvbixcbiAgICBjb21waWxlRXhjZXB0aW9uYWxSZXR1cm4sXG4gICAgY29tcGlsZVJldHVybixcbiAgICBjcmVhdGVUb3BvSWQsXG4gICAgY3JlYXRlQ29tcGlsZUNvbnRleHQsXG4gICAgZGVwZW5kc09uLFxuICAgIGFkZENvZGVCbG9jayxcblxuICAgIEFTVF9CTEtfRklFTERfUFJFX1BST0NFU1MsXG4gICAgQVNUX0JMS19QUk9DRVNTT1JfQ0FMTCxcbiAgICBBU1RfQkxLX1ZBTElEQVRPUl9DQUxMLFxuICAgIEFTVF9CTEtfQUNUSVZBVE9SX0NBTEwsXG4gICAgQVNUX0JMS19WSUVXX09QRVJBVElPTixcbiAgICBBU1RfQkxLX1ZJRVdfUkVUVVJOLFxuICAgIEFTVF9CTEtfSU5URVJGQUNFX09QRVJBVElPTixcbiAgICBBU1RfQkxLX0lOVEVSRkFDRV9SRVRVUk4sIFxuICAgIEFTVF9CTEtfRVhDRVBUSU9OX0lURU0sXG5cbiAgICBPT0xfTU9ESUZJRVJfQ09ERV9GTEFHXG59OyJdfQ==