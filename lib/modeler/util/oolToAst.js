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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9tb2RlbGVyL3V0aWwvb29sVG9Bc3QuanMiXSwibmFtZXMiOlsiXyIsInJlcXVpcmUiLCJUb3BvU29ydCIsIkpzTGFuZyIsIk9vbFR5cGVzIiwiaXNEb3RTZXBhcmF0ZU5hbWUiLCJleHRyYWN0RG90U2VwYXJhdGVOYW1lIiwiZXh0cmFjdFJlZmVyZW5jZUJhc2VOYW1lIiwiT29sb25nVmFsaWRhdG9ycyIsIk9vbG9uZ1Byb2Nlc3NvcnMiLCJPb2xvbmdBY3RpdmF0b3JzIiwiVHlwZXMiLCJkZWZhdWx0RXJyb3IiLCJBU1RfQkxLX0ZJRUxEX1BSRV9QUk9DRVNTIiwiQVNUX0JMS19QQVJBTV9TQU5JVElaRSIsIkFTVF9CTEtfUFJPQ0VTU09SX0NBTEwiLCJBU1RfQkxLX1ZBTElEQVRPUl9DQUxMIiwiQVNUX0JMS19BQ1RJVkFUT1JfQ0FMTCIsIkFTVF9CTEtfVklFV19PUEVSQVRJT04iLCJBU1RfQkxLX1ZJRVdfUkVUVVJOIiwiQVNUX0JMS19JTlRFUkZBQ0VfT1BFUkFUSU9OIiwiQVNUX0JMS19JTlRFUkZBQ0VfUkVUVVJOIiwiQVNUX0JMS19FWENFUFRJT05fSVRFTSIsIk9PTF9NT0RJRklFUl9DT0RFX0ZMQUciLCJNb2RpZmllciIsIlZBTElEQVRPUiIsIlBST0NFU1NPUiIsIkFDVElWQVRPUiIsIk9PTF9NT0RJRklFUl9PUCIsIk9PTF9NT0RJRklFUl9QQVRIIiwiT09MX01PRElGSUVSX0JVSUxUSU4iLCJjb21waWxlQ29uZGl0aW9uYWxFeHByZXNzaW9uIiwidGVzdCIsImNvbXBpbGVDb250ZXh0Iiwic3RhcnRUb3BvSWQiLCJpc1BsYWluT2JqZWN0Iiwib29sVHlwZSIsImVuZFRvcG9JZCIsImNyZWF0ZVRvcG9JZCIsIm9wZXJhbmRUb3BvSWQiLCJkZXBlbmRzT24iLCJsYXN0T3BlcmFuZFRvcG9JZCIsImNvbXBpbGVDb25jcmV0ZVZhbHVlRXhwcmVzc2lvbiIsImNhbGxlciIsImFzdEFyZ3VtZW50IiwiZ2V0Q29kZVJlcHJlc2VudGF0aW9uT2YiLCJyZXRUb3BvSWQiLCJjb21waWxlQWRIb2NWYWxpZGF0b3IiLCJjYWxsZWUiLCJvcCIsIm9wZXJhdG9yIiwiRXJyb3IiLCJsZWZ0VG9wb0lkIiwicmlnaHRUb3BvSWQiLCJsYXN0TGVmdElkIiwibGVmdCIsImxhc3RSaWdodElkIiwicmlnaHQiLCJhc3RNYXAiLCJhc3RCaW5FeHAiLCJhcmd1bWVudCIsImFzdE5vdCIsImFzdENhbGwiLCJ2YWx1ZVN0YXJ0VG9wb0lkIiwiYXN0VmFsdWUiLCJ0b3BvSWQiLCJ2YWx1ZSIsImZ1bmN0b3IiLCJjYWxsQXJncyIsImFyZ3MiLCJ0cmFuc2xhdGVBcmdzIiwiYXJnMCIsIm5hbWUiLCJjb25jYXQiLCJjb21waWxlTW9kaWZpZXIiLCJkZWNsYXJlUGFyYW1zIiwidHJhbnNsYXRlRnVuY3Rpb25QYXJhbXMiLCJpc0VtcHR5IiwiZnVuY3RvcklkIiwidHJhbnNsYXRlTW9kaWZpZXIiLCJyZWZlcmVuY2VzIiwiZXh0cmFjdFJlZmVyZW5jZWRGaWVsZHMiLCJmaW5kIiwicmVmIiwiaXNUb3BMZXZlbEJsb2NrIiwic3RhcnRzV2l0aCIsImFzdENvbmRpdGlvbmFsIiwicmVwbGFjZVZhclJlZlNjb3BlIiwiYWRkQ29kZUJsb2NrIiwidHlwZSIsInRhcmdldCIsIm9vbEFyZ3MiLCJjYXN0QXJyYXkiLCJyZWZzIiwiZm9yRWFjaCIsImEiLCJyZXN1bHQiLCJjaGVja1JlZmVyZW5jZVRvRmllbGQiLCJwdXNoIiwib2JqIiwidW5kZWZpbmVkIiwiYWRkTW9kaWZpZXJUb01hcCIsImZ1bmN0b3JUeXBlIiwiZnVuY3RvckpzRmlsZSIsIm1hcE9mRnVuY3RvclRvRmlsZSIsImZ1bmN0aW9uTmFtZSIsImZpbGVOYW1lIiwibmFtZXMiLCJsZW5ndGgiLCJyZWZFbnRpdHlOYW1lIiwidXBwZXJGaXJzdCIsImJ1aWx0aW5zIiwidGFyZ2V0TmFtZSIsIm5ld0Z1bmN0b3JGaWxlcyIsImNvbXBpbGVQaXBlZFZhbHVlIiwidmFyT29sIiwibGFzdFRvcG9JZCIsIm1vZGlmaWVycyIsIm1vZGlmaWVyIiwibW9kaWZpZXJTdGFydFRvcG9JZCIsImNvbXBpbGVWYXJpYWJsZVJlZmVyZW5jZSIsImJhc2VOYW1lIiwib3RoZXJzIiwic3BsaXQiLCJTZXQiLCJ0cmFuc2xhdGVGdW5jdGlvblBhcmFtIiwiYXJnIiwiaSIsInBvcCIsInRvU3RyaW5nIiwibWFwIiwiY291bnQiLCJoYXMiLCJhZGQiLCJyZWZCYXNlIiwicmVzdCIsImRlcGVuZGVuY3kiLCJtb2RlbFZhcnMiLCJyZWZGaWVsZE5hbWUiLCJKU09OIiwic3RyaW5naWZ5IiwibWFwVmFsdWVzIiwidmFsdWVPZkVsZW1lbnQiLCJrZXkiLCJzaWQiLCJlaWQiLCJBcnJheSIsImlzQXJyYXkiLCJpbmRleCIsImVhY2giLCJhcmdUb3BvSWQiLCJjb21waWxlUGFyYW0iLCJwYXJhbSIsInR5cGVPYmplY3QiLCJzYW5pdGl6ZXJOYW1lIiwidG9VcHBlckNhc2UiLCJ2YXJSZWYiLCJhc3RWYXJSZWYiLCJjYWxsQXN0IiwiYXN0QXJyYXlBY2Nlc3MiLCJwcmVwYXJlVG9wb0lkIiwiYXN0QXNzaWduIiwibWFpblN0YXJ0SWQiLCJ3cmFwUGFyYW1SZWZlcmVuY2UiLCJyZWFkeVRvcG9JZCIsImNvbXBpbGVGaWVsZCIsInBhcmFtTmFtZSIsImNvbnRleHROYW1lIiwiT2JqZWN0IiwiYXNzaWduIiwidHJhbnNsYXRlVGhlbkFzdCIsInN0YXJ0SWQiLCJlbmRJZCIsInRoZW4iLCJhc3NpZ25UbyIsImFzdFRocm93IiwiZXJyb3JUeXBlIiwibWVzc2FnZSIsInRyYW5zbGF0ZVJldHVyblZhbHVlQXN0IiwidmFsdWVFbmRJZCIsImFzdFJldHVybiIsInZhbHVlVG9wb0lkIiwiY29tcGlsZVJldHVybiIsImNvbXBpbGVGaW5kT25lIiwib3BlcmF0aW9uIiwiY29uZGl0aW9uVmFyTmFtZSIsImFzdCIsImFzdFZhckRlY2xhcmUiLCJjb25kaXRpb24iLCJ0b3BvSWRQcmVmaXgiLCJsYXN0U3RhdGVtZW50IiwiZWxzZSIsImVsc2VTdGFydCIsImVsc2VFbmQiLCJpdGVtcyIsInJldmVyc2UiLCJpdGVtIiwiY2FzZVByZWZpeCIsImNhc2VUb3BvSWQiLCJjYXNlUmVzdWx0VmFyTmFtZSIsImFzdENhc2VUdGVtIiwibW9kZWwiLCJpZlN0YXJ0IiwiaWZFbmQiLCJhc3RJZiIsImFzdEJsb2NrIiwiYXN0QXdhaXQiLCJtb2RlbFRvcG9JZCIsImNvbXBpbGVEYk9wZXJhdGlvbiIsImNvbXBpbGVFeGNlcHRpb25hbFJldHVybiIsIm9vbE5vZGUiLCJsYXN0RXhjZXB0aW9uSWQiLCJleGNlcHRpb25zIiwiZXhjZXB0aW9uU3RhcnRJZCIsImV4Y2VwdGlvbkVuZElkIiwidGhlblN0YXJ0SWQiLCJyZXR1cm5TdGFydFRvcG9JZCIsInRvcG9Ob2RlcyIsInRvcG9Tb3J0IiwiaGFzRGVwZW5kZW5jeSIsInByZXZpb3VzT3AiLCJjdXJyZW50T3AiLCJsb2dnZXIiLCJkZWJ1ZyIsImJsb2NrTWV0YSIsIm1hcE9mVG9rZW5Ub01ldGEiLCJzZXQiLCJ2ZXJib3NlIiwibGFzdFNvdXJjZVR5cGUiLCJnZXQiLCJvYmplY3QiLCJwcm9wZXJ0eSIsImNyZWF0ZUNvbXBpbGVDb250ZXh0Iiwic2hhcmVkQ29udGV4dCIsIk1hcCIsImluZGV4T2YiLCJ0YXJnZXRTY29wZSIsInBhcnRzIiwic3BsaWNlIiwiam9pbiIsIm1vZHVsZSIsImV4cG9ydHMiXSwibWFwcGluZ3MiOiJBQUFBOzs7O0FBT0EsTUFBTTtBQUFFQSxFQUFBQTtBQUFGLElBQVFDLE9BQU8sQ0FBQyxVQUFELENBQXJCOztBQUNBLE1BQU07QUFBRUMsRUFBQUE7QUFBRixJQUFlRCxPQUFPLENBQUMscUJBQUQsQ0FBNUI7O0FBRUEsTUFBTUUsTUFBTSxHQUFHRixPQUFPLENBQUMsVUFBRCxDQUF0Qjs7QUFDQSxNQUFNRyxRQUFRLEdBQUdILE9BQU8sQ0FBQyxxQkFBRCxDQUF4Qjs7QUFDQSxNQUFNO0FBQUVJLEVBQUFBLGlCQUFGO0FBQXFCQyxFQUFBQSxzQkFBckI7QUFBNkNDLEVBQUFBO0FBQTdDLElBQTBF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RUFBQUEsb0JBUGE7QUFRYmhNLEVBQUFBLFNBUmE7QUFTYmdELEVBQUFBLFlBVGE7QUFXYjNFLEVBQUFBLHlCQVhhO0FBWWJFLEVBQUFBLHNCQVphO0FBYWJDLEVBQUFBLHNCQWJhO0FBY2JDLEVBQUFBLHNCQWRhO0FBZWJDLEVBQUFBLHNCQWZhO0FBZ0JiQyxFQUFBQSxtQkFoQmE7QUFpQmJDLEVBQUFBLDJCQWpCYTtBQWtCYkMsRUFBQUEsd0JBbEJhO0FBbUJiQyxFQUFBQSxzQkFuQmE7QUFxQmJDLEVBQUFBO0FBckJhLENBQWpCIiwic291cmNlc0NvbnRlbnQiOlsiXCJ1c2Ugc3RyaWN0XCI7XG5cbi8qKlxuICogQG1vZHVsZVxuICogQGlnbm9yZVxuICovXG5cbmNvbnN0IHsgXyB9ID0gcmVxdWlyZSgncmstdXRpbHMnKTtcbmNvbnN0IHsgVG9wb1NvcnQgfSA9IHJlcXVpcmUoJ0BrLXN1aXRlL2FsZ29yaXRobXMnKTtcblxuY29uc3QgSnNMYW5nID0gcmVxdWlyZSgnLi9hc3QuanMnKTtcbmNvbnN0IE9vbFR5cGVzID0gcmVxdWlyZSgnLi4vLi4vbGFuZy9Pb2xUeXBlcycpO1xuY29uc3QgeyBpc0RvdFNlcGFyYXRlTmFtZSwgZXh0cmFjdERvdFNlcGFyYXRlTmFtZSwgZXh0cmFjdFJlZmVyZW5jZUJhc2VOYW1lIH0gPSByZXF1aXJlKCcuLi8uLi9sYW5nL09vbFV0aWxzJyk7XG5jb25zdCBPb2xvbmdWYWxpZGF0b3JzID0gcmVxdWlyZSgnLi4vLi4vcnVudGltZS9WYWxpZGF0b3JzJyk7XG5jb25zdCBPb2xvbmdQcm9jZXNzb3JzID0gcmVxdWlyZSgnLi4vLi4vcnVudGltZS9Qcm9jZXNzb3JzJyk7XG5jb25zdCBPb2xvbmdBY3RpdmF0b3JzID0gcmVxdWlyZSgnLi4vLi4vcnVudGltZS9BY3RpdmF0b3JzJyk7XG5jb25zdCBUeXBlcyA9IHJlcXVpcmUoJy4uLy4uL3J1bnRpbWUvdHlwZXMnKTtcblxuY29uc3QgZGVmYXVsdEVycm9yID0gJ0ludmFsaWRSZXF1ZXN0JztcblxuY29uc3QgQVNUX0JMS19GSUVMRF9QUkVfUFJPQ0VTUyA9ICdGaWVsZFByZVByb2Nlc3MnO1xuY29uc3QgQVNUX0JMS19QQVJBTV9TQU5JVElaRSA9ICdQYXJhbWV0ZXJTYW5pdGl6ZSc7XG5jb25zdCBBU1RfQkxLX1BST0NFU1NPUl9DQUxMID0gJ1Byb2Nlc3NvckNhbGwnO1xuY29uc3QgQVNUX0JMS19WQUxJREFUT1JfQ0FMTCA9ICdWYWxpZGF0b3JDYWxsJztcbmNvbnN0IEFTVF9CTEtfQUNUSVZBVE9SX0NBTEwgPSAnQWN0aXZhdG9yQ2FsbCc7XG5jb25zdCBBU1RfQkxLX1ZJRVdfT1BFUkFUSU9OID0gJ1ZpZXdPcGVyYXRpb24nO1xuY29uc3QgQVNUX0JMS19WSUVXX1JFVFVSTiA9ICdWaWV3UmV0dXJuJztcbmNvbnN0IEFTVF9CTEtfSU5URVJGQUNFX09QRVJBVElPTiA9ICdJbnRlcmZhY2VPcGVyYXRpb24nO1xuY29uc3QgQVNUX0JMS19JTlRFUkZBQ0VfUkVUVVJOID0gJ0ludGVyZmFjZVJldHVybic7XG5jb25zdCBBU1RfQkxLX0VYQ0VQVElPTl9JVEVNID0gJ0V4Y2VwdGlvbkl0ZW0nO1xuXG5jb25zdCBPT0xfTU9ESUZJRVJfQ09ERV9GTEFHID0ge1xuICAgIFtPb2xUeXBlcy5Nb2RpZmllci5WQUxJREFUT1JdOiBBU1RfQkxLX1ZBTElEQVRPUl9DQUxMLFxuICAgIFtPb2xUeXBlcy5Nb2RpZmllci5QUk9DRVNTT1JdOiBBU1RfQkxLX1BST0NFU1NPUl9DQUxMLFxuICAgIFtPb2xUeXBlcy5Nb2RpZmllci5BQ1RJVkFUT1JdOiBBU1RfQkxLX0FDVElWQVRPUl9DQUxMXG59O1xuXG5jb25zdCBPT0xfTU9ESUZJRVJfT1AgPSB7XG4gICAgW09vbFR5cGVzLk1vZGlmaWVyLlZBTElEQVRPUl06ICd+JyxcbiAgICBbT29sVHlwZXMuTW9kaWZpZXIuUFJPQ0VTU09SXTogJ3w+JyxcbiAgICBbT29sVHlwZXMuTW9kaWZpZXIuQUNUSVZBVE9SXTogJz0nIFxufTtcblxuY29uc3QgT09MX01PRElGSUVSX1BBVEggPSB7XG4gICAgW09vbFR5cGVzLk1vZGlmaWVyLlZBTElEQVRPUl06ICd2YWxpZGF0b3JzJyxcbiAgICBbT29sVHlwZXMuTW9kaWZpZXIuUFJPQ0VTU09SXTogJ3Byb2Nlc3NvcnMnLFxuICAgIFtPb2xUeXBlcy5Nb2RpZmllci5BQ1RJVkFUT1JdOiAnYWN0aXZhdG9ycycgXG59O1xuXG5jb25zdCBPT0xfTU9ESUZJRVJfQlVJTFRJTiA9IHtcbiAgICBbT29sVHlwZXMuTW9kaWZpZXIuVkFMSURBVE9SXTogT29sb25nVmFsaWRhdG9ycyxcbiAgICBbT29sVHlwZXMuTW9kaWZpZXIuUFJPQ0VTU09SXTogT29sb25nUHJvY2Vzc29ycyxcbiAgICBbT29sVHlwZXMuTW9kaWZpZXIuQUNUSVZBVE9SXTogT29sb25nQWN0aXZhdG9ycyBcbn07XG5cbi8qKlxuICogQ29tcGlsZSBhIGNvbmRpdGlvbmFsIGV4cHJlc3Npb25cbiAqIEBwYXJhbSB7b2JqZWN0fSB0ZXN0XG4gKiBAcGFyYW0ge29iamVjdH0gY29tcGlsZUNvbnRleHRcbiAqIEBwcm9wZXJ0eSB7c3RyaW5nfSBjb21waWxlQ29udGV4dC50YXJnZXROYW1lXG4gKiBAcHJvcGVydHkge1RvcG9Tb3J0fSBjb21waWxlQ29udGV4dC50b3BvU29ydFxuICogQHByb3BlcnR5IHtvYmplY3R9IGNvbXBpbGVDb250ZXh0LmFzdE1hcCAtIFRvcG8gSWQgdG8gYXN0IG1hcFxuICogQHBhcmFtIHtzdHJpbmd9IHN0YXJ0VG9wb0lkXG4gKiBAcmV0dXJucyB7c3RyaW5nfSBUb3BvIElkXG4gKi9cbmZ1bmN0aW9uIGNvbXBpbGVDb25kaXRpb25hbEV4cHJlc3Npb24odGVzdCwgY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkKSB7XG4gICAgaWYgKF8uaXNQbGFpbk9iamVjdCh0ZXN0KSkgeyAgICAgICAgXG4gICAgICAgIGlmICh0ZXN0Lm9vbFR5cGUgPT09ICdWYWxpZGF0ZUV4cHJlc3Npb24nKSB7XG4gICAgICAgICAgICBsZXQgZW5kVG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCArICckdmFsaU9wOmRvbmUnKTtcbiAgICAgICAgICAgIGxldCBvcGVyYW5kVG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCArICckdmFsaU9wJyk7XG5cbiAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgc3RhcnRUb3BvSWQsIG9wZXJhbmRUb3BvSWQpO1xuXG4gICAgICAgICAgICBsZXQgbGFzdE9wZXJhbmRUb3BvSWQgPSBjb21waWxlQ29uY3JldGVWYWx1ZUV4cHJlc3Npb24ob3BlcmFuZFRvcG9JZCwgdGVzdC5jYWxsZXIsIGNvbXBpbGVDb250ZXh0KTtcbiAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgbGFzdE9wZXJhbmRUb3BvSWQsIGVuZFRvcG9JZCk7XG5cbiAgICAgICAgICAgIGxldCBhc3RBcmd1bWVudCA9IGdldENvZGVSZXByZXNlbnRhdGlvbk9mKGxhc3RPcGVyYW5kVG9wb0lkLCBjb21waWxlQ29udGV4dCk7XG5cbiAgICAgICAgICAgIGxldCByZXRUb3BvSWQgPSBjb21waWxlQWRIb2NWYWxpZGF0b3IoZW5kVG9wb0lkLCBhc3RBcmd1bWVudCwgdGVzdC5jYWxsZWUsIGNvbXBpbGVDb250ZXh0KTtcblxuICAgICAgICAgICAgYXNzZXJ0OiByZXRUb3BvSWQgPT09IGVuZFRvcG9JZDtcblxuICAgICAgICAgICAgLypcbiAgICAgICAgICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtlbmRUb3BvSWRdID0gSnNMYW5nLmFzdENhbGwoJ18uaXNFbXB0eScsIGFzdEFyZ3VtZW50KTtcblxuICAgICAgICAgICAgc3dpdGNoICh0ZXN0Lm9wZXJhdG9yKSB7XG4gICAgICAgICAgICAgICAgY2FzZSAnZXhpc3RzJzpcbiAgICAgICAgICAgICAgICAgICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW2VuZFRvcG9JZF0gPSBKc0xhbmcuYXN0Tm90KEpzTGFuZy5hc3RDYWxsKCdfLmlzRW1wdHknLCBhc3RBcmd1bWVudCkpO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgICAgIGNhc2UgJ2lzLW5vdC1udWxsJzpcbiAgICAgICAgICAgICAgICAgICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW2VuZFRvcG9JZF0gPSBKc0xhbmcuYXN0Tm90KEpzTGFuZy5hc3RDYWxsKCdfLmlzTmlsJywgYXN0QXJndW1lbnQpKTtcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgICAgICBjYXNlICdub3QtZXhpc3RzJzpcbiAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgY2FzZSAnaXMtbnVsbCc6XG4gICAgICAgICAgICAgICAgICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtlbmRUb3BvSWRdID0gSnNMYW5nLmFzdENhbGwoJ18uaXNOaWwnLCBhc3RBcmd1bWVudCk7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgY2FzZSAnbm90JzpcbiAgICAgICAgICAgICAgICAgICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW2VuZFRvcG9JZF0gPSBKc0xhbmcuYXN0Tm90KGFzdEFyZ3VtZW50KTtcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1Vuc3VwcG9ydGVkIHRlc3Qgb3BlcmF0b3I6ICcgKyB0ZXN0Lm9wZXJhdG9yKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgICovXG5cbiAgICAgICAgICAgIHJldHVybiBlbmRUb3BvSWQ7XG5cbiAgICAgICAgfSBlbHNlIGlmICh0ZXN0Lm9vbFR5cGUgPT09ICdMb2dpY2FsRXhwcmVzc2lvbicpIHtcbiAgICAgICAgICAgIGxldCBlbmRUb3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkICsgJyRsb3BPcDpkb25lJyk7XG5cbiAgICAgICAgICAgIGxldCBvcDtcblxuICAgICAgICAgICAgc3dpdGNoICh0ZXN0Lm9wZXJhdG9yKSB7XG4gICAgICAgICAgICAgICAgY2FzZSAnYW5kJzpcbiAgICAgICAgICAgICAgICAgICAgb3AgPSAnJiYnO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgICAgIGNhc2UgJ29yJzpcbiAgICAgICAgICAgICAgICAgICAgb3AgPSAnfHwnO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5zdXBwb3J0ZWQgdGVzdCBvcGVyYXRvcjogJyArIHRlc3Qub3BlcmF0b3IpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgbGVmdFRvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgc3RhcnRUb3BvSWQgKyAnJGxvcE9wOmxlZnQnKTtcbiAgICAgICAgICAgIGxldCByaWdodFRvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgc3RhcnRUb3BvSWQgKyAnJGxvcE9wOnJpZ2h0Jyk7XG5cbiAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgc3RhcnRUb3BvSWQsIGxlZnRUb3BvSWQpO1xuICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCwgcmlnaHRUb3BvSWQpO1xuXG4gICAgICAgICAgICBsZXQgbGFzdExlZnRJZCA9IGNvbXBpbGVDb25kaXRpb25hbEV4cHJlc3Npb24odGVzdC5sZWZ0LCBjb21waWxlQ29udGV4dCwgbGVmdFRvcG9JZCk7XG4gICAgICAgICAgICBsZXQgbGFzdFJpZ2h0SWQgPSBjb21waWxlQ29uZGl0aW9uYWxFeHByZXNzaW9uKHRlc3QucmlnaHQsIGNvbXBpbGVDb250ZXh0LCByaWdodFRvcG9JZCk7XG5cbiAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgbGFzdExlZnRJZCwgZW5kVG9wb0lkKTtcbiAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgbGFzdFJpZ2h0SWQsIGVuZFRvcG9JZCk7XG5cbiAgICAgICAgICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtlbmRUb3BvSWRdID0gSnNMYW5nLmFzdEJpbkV4cChcbiAgICAgICAgICAgICAgICBnZXRDb2RlUmVwcmVzZW50YXRpb25PZihsYXN0TGVmdElkLCBjb21waWxlQ29udGV4dCksXG4gICAgICAgICAgICAgICAgb3AsXG4gICAgICAgICAgICAgICAgZ2V0Q29kZVJlcHJlc2VudGF0aW9uT2YobGFzdFJpZ2h0SWQsIGNvbXBpbGVDb250ZXh0KVxuICAgICAgICAgICAgKTsgXG5cbiAgICAgICAgICAgIHJldHVybiBlbmRUb3BvSWQ7XG5cbiAgICAgICAgfSBlbHNlIGlmICh0ZXN0Lm9vbFR5cGUgPT09ICdCaW5hcnlFeHByZXNzaW9uJykge1xuICAgICAgICAgICAgbGV0IGVuZFRvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgc3RhcnRUb3BvSWQgKyAnJGJpbk9wOmRvbmUnKTtcblxuICAgICAgICAgICAgbGV0IG9wO1xuXG4gICAgICAgICAgICBzd2l0Y2ggKHRlc3Qub3BlcmF0b3IpIHtcbiAgICAgICAgICAgICAgICBjYXNlICc+JzpcbiAgICAgICAgICAgICAgICBjYXNlICc8JzpcbiAgICAgICAgICAgICAgICBjYXNlICc+PSc6XG4gICAgICAgICAgICAgICAgY2FzZSAnPD0nOlxuICAgICAgICAgICAgICAgIGNhc2UgJ2luJzpcbiAgICAgICAgICAgICAgICAgICAgb3AgPSB0ZXN0Lm9wZXJhdG9yO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgICAgIGNhc2UgJz09JzpcbiAgICAgICAgICAgICAgICAgICAgb3AgPSAnPT09JztcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgICAgICBjYXNlICchPSc6XG4gICAgICAgICAgICAgICAgICAgIG9wID0gJyE9PSc7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbnN1cHBvcnRlZCB0ZXN0IG9wZXJhdG9yOiAnICsgdGVzdC5vcGVyYXRvcik7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCBsZWZ0VG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCArICckYmluT3A6bGVmdCcpO1xuICAgICAgICAgICAgbGV0IHJpZ2h0VG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCArICckYmluT3A6cmlnaHQnKTtcblxuICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCwgbGVmdFRvcG9JZCk7XG4gICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkLCByaWdodFRvcG9JZCk7XG5cbiAgICAgICAgICAgIGxldCBsYXN0TGVmdElkID0gY29tcGlsZUNvbmNyZXRlVmFsdWVFeHByZXNzaW9uKGxlZnRUb3BvSWQsIHRlc3QubGVmdCwgY29tcGlsZUNvbnRleHQpO1xuICAgICAgICAgICAgbGV0IGxhc3RSaWdodElkID0gY29tcGlsZUNvbmNyZXRlVmFsdWVFeHByZXNzaW9uKHJpZ2h0VG9wb0lkLCB0ZXN0LnJpZ2h0LCBjb21waWxlQ29udGV4dCk7XG5cbiAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgbGFzdExlZnRJZCwgZW5kVG9wb0lkKTtcbiAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgbGFzdFJpZ2h0SWQsIGVuZFRvcG9JZCk7XG5cbiAgICAgICAgICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtlbmRUb3BvSWRdID0gSnNMYW5nLmFzdEJpbkV4cChcbiAgICAgICAgICAgICAgICBnZXRDb2RlUmVwcmVzZW50YXRpb25PZihsYXN0TGVmdElkLCBjb21waWxlQ29udGV4dCksXG4gICAgICAgICAgICAgICAgb3AsXG4gICAgICAgICAgICAgICAgZ2V0Q29kZVJlcHJlc2VudGF0aW9uT2YobGFzdFJpZ2h0SWQsIGNvbXBpbGVDb250ZXh0KVxuICAgICAgICAgICAgKTsgXG5cbiAgICAgICAgICAgIHJldHVybiBlbmRUb3BvSWQ7XG5cbiAgICAgICAgfSBlbHNlIGlmICh0ZXN0Lm9vbFR5cGUgPT09ICdVbmFyeUV4cHJlc3Npb24nKSB7XG4gICAgICAgICAgICBsZXQgZW5kVG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCArICckdW5hT3A6ZG9uZScpO1xuICAgICAgICAgICAgbGV0IG9wZXJhbmRUb3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkICsgJyR1bmFPcCcpO1xuXG4gICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkLCBvcGVyYW5kVG9wb0lkKTtcblxuICAgICAgICAgICAgbGV0IGxhc3RPcGVyYW5kVG9wb0lkID0gdGVzdC5vcGVyYXRvciA9PT0gJ25vdCcgPyBjb21waWxlQ29uY3JldGVWYWx1ZUV4cHJlc3Npb24ob3BlcmFuZFRvcG9JZCwgdGVzdC5hcmd1bWVudCwgY29tcGlsZUNvbnRleHQpIDogY29tcGlsZUNvbmRpdGlvbmFsRXhwcmVzc2lvbih0ZXN0LmFyZ3VtZW50LCBjb21waWxlQ29udGV4dCwgb3BlcmFuZFRvcG9JZCk7XG4gICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIGxhc3RPcGVyYW5kVG9wb0lkLCBlbmRUb3BvSWQpO1xuXG4gICAgICAgICAgICBsZXQgYXN0QXJndW1lbnQgPSBnZXRDb2RlUmVwcmVzZW50YXRpb25PZihsYXN0T3BlcmFuZFRvcG9JZCwgY29tcGlsZUNvbnRleHQpO1xuXG4gICAgICAgICAgICBzd2l0Y2ggKHRlc3Qub3BlcmF0b3IpIHtcbiAgICAgICAgICAgICAgICBjYXNlICdleGlzdHMnOlxuICAgICAgICAgICAgICAgICAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbZW5kVG9wb0lkXSA9IEpzTGFuZy5hc3ROb3QoSnNMYW5nLmFzdENhbGwoJ18uaXNFbXB0eScsIGFzdEFyZ3VtZW50KSk7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgY2FzZSAnaXMtbm90LW51bGwnOlxuICAgICAgICAgICAgICAgICAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbZW5kVG9wb0lkXSA9IEpzTGFuZy5hc3ROb3QoSnNMYW5nLmFzdENhbGwoJ18uaXNOaWwnLCBhc3RBcmd1bWVudCkpO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgICAgIGNhc2UgJ25vdC1leGlzdHMnOlxuICAgICAgICAgICAgICAgICAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbZW5kVG9wb0lkXSA9IEpzTGFuZy5hc3RDYWxsKCdfLmlzRW1wdHknLCBhc3RBcmd1bWVudCk7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgY2FzZSAnaXMtbnVsbCc6XG4gICAgICAgICAgICAgICAgICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtlbmRUb3BvSWRdID0gSnNMYW5nLmFzdENhbGwoJ18uaXNOaWwnLCBhc3RBcmd1bWVudCk7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgY2FzZSAnbm90JzpcbiAgICAgICAgICAgICAgICAgICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW2VuZFRvcG9JZF0gPSBKc0xhbmcuYXN0Tm90KGFzdEFyZ3VtZW50KTtcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1Vuc3VwcG9ydGVkIHRlc3Qgb3BlcmF0b3I6ICcgKyB0ZXN0Lm9wZXJhdG9yKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIGVuZFRvcG9JZDtcblxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgbGV0IHZhbHVlU3RhcnRUb3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkICsgJyR2YWx1ZScpO1xuICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCwgdmFsdWVTdGFydFRvcG9JZCk7XG4gICAgICAgICAgICByZXR1cm4gY29tcGlsZUNvbmNyZXRlVmFsdWVFeHByZXNzaW9uKHZhbHVlU3RhcnRUb3BvSWQsIHRlc3QsIGNvbXBpbGVDb250ZXh0KTtcbiAgICAgICAgfSBcbiAgICB9XG5cbiAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbc3RhcnRUb3BvSWRdID0gSnNMYW5nLmFzdFZhbHVlKHRlc3QpO1xuICAgIHJldHVybiBzdGFydFRvcG9JZDtcbn1cblxuLyoqXG4gKiBDb21waWxlIGEgdmFsaWRhdG9yIGNhbGxlZCBpbiBhIGxvZ2ljYWwgZXhwcmVzc2lvbi5cbiAqIEBwYXJhbSB2YWx1ZVxuICogQHBhcmFtIGZ1bmN0b3JzXG4gKiBAcGFyYW0gY29tcGlsZUNvbnRleHRcbiAqIEBwYXJhbSB0b3BvSW5mb1xuICogQHByb3BlcnR5IHtzdHJpbmd9IHRvcG9JbmZvLnRvcG9JZFByZWZpeFxuICogQHByb3BlcnR5IHtzdHJpbmd9IHRvcG9JbmZvLmxhc3RUb3BvSWRcbiAqIEByZXR1cm5zIHsqfHN0cmluZ31cbiAqL1xuZnVuY3Rpb24gY29tcGlsZUFkSG9jVmFsaWRhdG9yKHRvcG9JZCwgdmFsdWUsIGZ1bmN0b3IsIGNvbXBpbGVDb250ZXh0KSB7XG4gICAgYXNzZXJ0OiBmdW5jdG9yLm9vbFR5cGUgPT09IE9vbFR5cGVzLk1vZGlmaWVyLlZBTElEQVRPUjsgICAgICAgIFxuXG4gICAgbGV0IGNhbGxBcmdzO1xuICAgIFxuICAgIGlmIChmdW5jdG9yLmFyZ3MpIHtcbiAgICAgICAgY2FsbEFyZ3MgPSB0cmFuc2xhdGVBcmdzKHRvcG9JZCwgZnVuY3Rvci5hcmdzLCBjb21waWxlQ29udGV4dCk7ICAgICAgICBcbiAgICB9IGVsc2Uge1xuICAgICAgICBjYWxsQXJncyA9IFtdO1xuICAgIH0gICAgICAgICAgICBcbiAgICBcbiAgICBsZXQgYXJnMCA9IHZhbHVlO1xuICAgIFxuICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFt0b3BvSWRdID0gSnNMYW5nLmFzdENhbGwoJ1ZhbGlkYXRvcnMuJyArIGZ1bmN0b3IubmFtZSwgWyBhcmcwIF0uY29uY2F0KGNhbGxBcmdzKSk7XG5cbiAgICByZXR1cm4gdG9wb0lkO1xufVxuXG4vKipcbiAqIENvbXBpbGUgYSBtb2RpZmllciBmcm9tIG9vbCB0byBhc3QuXG4gKiBAcGFyYW0gdmFsdWVcbiAqIEBwYXJhbSBmdW5jdG9yc1xuICogQHBhcmFtIGNvbXBpbGVDb250ZXh0XG4gKiBAcGFyYW0gdG9wb0luZm9cbiAqIEBwcm9wZXJ0eSB7c3RyaW5nfSB0b3BvSW5mby50b3BvSWRQcmVmaXhcbiAqIEBwcm9wZXJ0eSB7c3RyaW5nfSB0b3BvSW5mby5sYXN0VG9wb0lkXG4gKiBAcmV0dXJucyB7KnxzdHJpbmd9XG4gKi9cbmZ1bmN0aW9uIGNvbXBpbGVNb2RpZmllcih0b3BvSWQsIHZhbHVlLCBmdW5jdG9yLCBjb21waWxlQ29udGV4dCkge1xuICAgIGxldCBkZWNsYXJlUGFyYW1zO1xuXG4gICAgaWYgKGZ1bmN0b3Iub29sVHlwZSA9PT0gT29sVHlwZXMuTW9kaWZpZXIuQUNUSVZBVE9SKSB7IFxuICAgICAgICBkZWNsYXJlUGFyYW1zID0gdHJhbnNsYXRlRnVuY3Rpb25QYXJhbXMoZnVuY3Rvci5hcmdzKTsgICAgICAgIFxuICAgIH0gZWxzZSB7XG4gICAgICAgIGRlY2xhcmVQYXJhbXMgPSB0cmFuc2xhdGVGdW5jdGlvblBhcmFtcyhfLmlzRW1wdHkoZnVuY3Rvci5hcmdzKSA/IFt2YWx1ZV0gOiBbdmFsdWVdLmNvbmNhdChmdW5jdG9yLmFyZ3MpKTsgICAgICAgIFxuICAgIH0gICAgICAgIFxuXG4gICAgbGV0IGZ1bmN0b3JJZCA9IHRyYW5zbGF0ZU1vZGlmaWVyKGZ1bmN0b3IsIGNvbXBpbGVDb250ZXh0LCBkZWNsYXJlUGFyYW1zKTtcblxuICAgIGxldCBjYWxsQXJncywgcmVmZXJlbmNlcztcbiAgICBcbiAgICBpZiAoZnVuY3Rvci5hcmdzKSB7XG4gICAgICAgIGNhbGxBcmdzID0gdHJhbnNsYXRlQXJncyh0b3BvSWQsIGZ1bmN0b3IuYXJncywgY29tcGlsZUNvbnRleHQpO1xuICAgICAgICByZWZlcmVuY2VzID0gZXh0cmFjdFJlZmVyZW5jZWRGaWVsZHMoZnVuY3Rvci5hcmdzKTtcblxuICAgICAgICBpZiAoXy5maW5kKHJlZmVyZW5jZXMsIHJlZiA9PiByZWYgPT09IHZhbHVlLm5hbWUpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ0Nhbm5vdCB1c2UgdGhlIHRhcmdldCBmaWVsZCBpdHNlbGYgYXMgYW4gYXJndW1lbnQgb2YgYSBtb2RpZmllci4nKTtcbiAgICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICAgIGNhbGxBcmdzID0gW107XG4gICAgfSAgICAgICAgXG4gICAgXG4gICAgaWYgKGZ1bmN0b3Iub29sVHlwZSA9PT0gT29sVHlwZXMuTW9kaWZpZXIuQUNUSVZBVE9SKSB7ICAgICAgICAgICAgXG4gICAgICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFt0b3BvSWRdID0gSnNMYW5nLmFzdENhbGwoZnVuY3RvcklkLCBjYWxsQXJncyk7XG4gICAgfSBlbHNlIHtcbiAgICAgICAgbGV0IGFyZzAgPSB2YWx1ZTtcbiAgICAgICAgaWYgKCFpc1RvcExldmVsQmxvY2sodG9wb0lkKSAmJiBfLmlzUGxhaW5PYmplY3QodmFsdWUpICYmIHZhbHVlLm9vbFR5cGUgPT09ICdPYmplY3RSZWZlcmVuY2UnICYmIHZhbHVlLm5hbWUuc3RhcnRzV2l0aCgnbGF0ZXN0LicpKSB7XG4gICAgICAgICAgICAvL2xldCBleGlzdGluZ1JlZiA9ICAgICAgICAgICAgXG4gICAgICAgICAgICBhcmcwID0gSnNMYW5nLmFzdENvbmRpdGlvbmFsKFxuICAgICAgICAgICAgICAgIEpzTGFuZy5hc3RDYWxsKCdsYXRlc3QuaGFzT3duUHJvcGVydHknLCBbIGV4dHJhY3RSZWZlcmVuY2VCYXNlTmFtZSh2YWx1ZS5uYW1lKSBdKSwgLyoqIHRlc3QgKi9cbiAgICAgICAgICAgICAgICB2YWx1ZSwgLyoqIGNvbnNlcXVlbnQgKi9cbiAgICAgICAgICAgICAgICByZXBsYWNlVmFyUmVmU2NvcGUodmFsdWUsICdleGlzdGluZycpXG4gICAgICAgICAgICApOyAgXG4gICAgICAgIH1cbiAgICAgICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW3RvcG9JZF0gPSBKc0xhbmcuYXN0Q2FsbChmdW5jdG9ySWQsIFsgYXJnMCBdLmNvbmNhdChjYWxsQXJncykpO1xuICAgIH0gICAgXG5cbiAgICBpZiAoaXNUb3BMZXZlbEJsb2NrKHRvcG9JZCkpIHtcbiAgICAgICAgYWRkQ29kZUJsb2NrKGNvbXBpbGVDb250ZXh0LCB0b3BvSWQsIHtcbiAgICAgICAgICAgIHR5cGU6IE9PTF9NT0RJRklFUl9DT0RFX0ZMQUdbZnVuY3Rvci5vb2xUeXBlXSxcbiAgICAgICAgICAgIHRhcmdldDogdmFsdWUubmFtZSxcbiAgICAgICAgICAgIHJlZmVyZW5jZXM6IHJlZmVyZW5jZXMgICAvLyBsYXRlc3QuLCBleHNpdGluZy4sIHJhdy5cbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgcmV0dXJuIHRvcG9JZDtcbn0gIFxuICAgICAgXG5mdW5jdGlvbiBleHRyYWN0UmVmZXJlbmNlZEZpZWxkcyhvb2xBcmdzKSB7ICAgXG4gICAgb29sQXJncyA9IF8uY2FzdEFycmF5KG9vbEFyZ3MpOyAgICBcblxuICAgIGxldCByZWZzID0gW107XG5cbiAgICBvb2xBcmdzLmZvckVhY2goYSA9PiB7XG4gICAgICAgIGxldCByZXN1bHQgPSBjaGVja1JlZmVyZW5jZVRvRmllbGQoYSk7XG4gICAgICAgIGlmIChyZXN1bHQpIHtcbiAgICAgICAgICAgIHJlZnMucHVzaChyZXN1bHQpO1xuICAgICAgICB9XG4gICAgfSk7XG5cbiAgICByZXR1cm4gcmVmcztcbn1cblxuZnVuY3Rpb24gY2hlY2tSZWZlcmVuY2VUb0ZpZWxkKG9iaikge1xuICAgIGlmIChfLmlzUGxhaW5PYmplY3Qob2JqKSAmJiBvYmoub29sVHlwZSkge1xuICAgICAgICBpZiAob2JqLm9vbFR5cGUgPT09ICdQaXBlZFZhbHVlJykgcmV0dXJuIGNoZWNrUmVmZXJlbmNlVG9GaWVsZChvYmoudmFsdWUpO1xuICAgICAgICBpZiAob2JqLm9vbFR5cGUgPT09ICdPYmplY3RSZWZlcmVuY2UnKSB7XG4gICAgICAgICAgICByZXR1cm4gb2JqLm5hbWU7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICByZXR1cm4gdW5kZWZpbmVkO1xufVxuXG5mdW5jdGlvbiBhZGRNb2RpZmllclRvTWFwKGZ1bmN0b3JJZCwgZnVuY3RvclR5cGUsIGZ1bmN0b3JKc0ZpbGUsIG1hcE9mRnVuY3RvclRvRmlsZSkge1xuICAgIGlmIChtYXBPZkZ1bmN0b3JUb0ZpbGVbZnVuY3RvcklkXSAmJiBtYXBPZkZ1bmN0b3JUb0ZpbGVbZnVuY3RvcklkXSAhPT0gZnVuY3RvckpzRmlsZSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYENvbmZsaWN0OiAke2Z1bmN0b3JUeXBlfSBuYW1pbmcgXCIke2Z1bmN0b3JJZH1cIiBjb25mbGljdHMhYCk7XG4gICAgfVxuICAgIG1hcE9mRnVuY3RvclRvRmlsZVtmdW5jdG9ySWRdID0gZnVuY3RvckpzRmlsZTtcbn1cblxuLyoqXG4gKiBDaGVjayB3aGV0aGVyIGEgZnVuY3RvciBpcyB1c2VyLWRlZmluZWQgb3IgYnVpbHQtaW5cbiAqIEBwYXJhbSBmdW5jdG9yXG4gKiBAcGFyYW0gY29tcGlsZUNvbnRleHRcbiAqIEBwYXJhbSBhcmdzIC0gVXNlZCB0byBtYWtlIHVwIHRoZSBmdW5jdGlvbiBzaWduYXR1cmVcbiAqIEByZXR1cm5zIHtzdHJpbmd9IGZ1bmN0b3IgaWRcbiAqL1xuZnVuY3Rpb24gdHJhbnNsYXRlTW9kaWZpZXIoZnVuY3RvciwgY29tcGlsZUNvbnRleHQsIGFyZ3MpIHtcbiAgICBsZXQgZnVuY3Rpb25OYW1lLCBmaWxlTmFtZSwgZnVuY3RvcklkO1xuXG4gICAgLy9leHRyYWN0IHZhbGlkYXRvciBuYW1pbmcgYW5kIGltcG9ydCBpbmZvcm1hdGlvblxuICAgIGlmIChpc0RvdFNlcGFyYXRlTmFtZShmdW5jdG9yLm5hbWUpKSB7XG4gICAgICAgIGxldCBuYW1lcyA9IGV4dHJhY3REb3RTZXBhcmF0ZU5hbWUoZnVuY3Rvci5uYW1lKTtcbiAgICAgICAgaWYgKG5hbWVzLmxlbmd0aCA+IDIpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignTm90IHN1cHBvcnRlZCByZWZlcmVuY2UgdHlwZTogJyArIGZ1bmN0b3IubmFtZSk7XG4gICAgICAgIH1cblxuICAgICAgICAvL3JlZmVyZW5jZSB0byBvdGhlciBlbnRpdHkgZmlsZVxuICAgICAgICBsZXQgcmVmRW50aXR5TmFtZSA9IG5hbWVzWzBdO1xuICAgICAgICBmdW5jdGlvbk5hbWUgPSBuYW1lc1sxXTtcbiAgICAgICAgZmlsZU5hbWUgPSAnLi8nICsgT09MX01PRElGSUVSX1BBVEhbZnVuY3Rvci5vb2xUeXBlXSArICcvJyArIHJlZkVudGl0eU5hbWUgKyAnLScgKyBmdW5jdGlvbk5hbWUgKyAnLmpzJztcbiAgICAgICAgZnVuY3RvcklkID0gcmVmRW50aXR5TmFtZSArIF8udXBwZXJGaXJzdChmdW5jdGlvbk5hbWUpO1xuICAgICAgICBhZGRNb2RpZmllclRvTWFwKGZ1bmN0b3JJZCwgZnVuY3Rvci5vb2xUeXBlLCBmaWxlTmFtZSwgY29tcGlsZUNvbnRleHQubWFwT2ZGdW5jdG9yVG9GaWxlKTtcblxuICAgIH0gZWxzZSB7XG4gICAgICAgIGZ1bmN0aW9uTmFtZSA9IGZ1bmN0b3IubmFtZTtcblxuICAgICAgICBsZXQgYnVpbHRpbnMgPSBPT0xfTU9ESUZJRVJfQlVJTFRJTltmdW5jdG9yLm9vbFR5cGVdO1xuXG4gICAgICAgIGlmICghKGZ1bmN0aW9uTmFtZSBpbiBidWlsdGlucykpIHtcbiAgICAgICAgICAgIGZpbGVOYW1lID0gJy4vJyArIE9PTF9NT0RJRklFUl9QQVRIW2Z1bmN0b3Iub29sVHlwZV0gKyAnLycgKyBjb21waWxlQ29udGV4dC50YXJnZXROYW1lICsgJy0nICsgZnVuY3Rpb25OYW1lICsgJy5qcyc7XG4gICAgICAgICAgICBmdW5jdG9ySWQgPSBmdW5jdGlvbk5hbWU7XG5cbiAgICAgICAgICAgIGlmICghY29tcGlsZUNvbnRleHQubWFwT2ZGdW5jdG9yVG9GaWxlW2Z1bmN0b3JJZF0pIHtcbiAgICAgICAgICAgICAgICBjb21waWxlQ29udGV4dC5uZXdGdW5jdG9yRmlsZXMucHVzaCh7XG4gICAgICAgICAgICAgICAgICAgIGZ1bmN0aW9uTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgZnVuY3RvclR5cGU6IGZ1bmN0b3Iub29sVHlwZSxcbiAgICAgICAgICAgICAgICAgICAgZmlsZU5hbWUsXG4gICAgICAgICAgICAgICAgICAgIGFyZ3NcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYWRkTW9kaWZpZXJUb01hcChmdW5jdG9ySWQsIGZ1bmN0b3Iub29sVHlwZSwgZmlsZU5hbWUsIGNvbXBpbGVDb250ZXh0Lm1hcE9mRnVuY3RvclRvRmlsZSk7ICAgICAgICAgICAgXG4gICAgICAgIH0gZWxzZSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBmdW5jdG9ySWQgPSBmdW5jdG9yLm9vbFR5cGUgKyAncy4nICsgZnVuY3Rpb25OYW1lO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgcmV0dXJuIGZ1bmN0b3JJZDtcbn1cblxuLyoqXG4gKiBDb21waWxlIGEgcGlwZWQgdmFsdWUgZnJvbSBvb2wgdG8gYXN0LlxuICogQHBhcmFtIHtzdHJpbmd9IHN0YXJ0VG9wb0lkIC0gVGhlIHRvcG9sb2dpY2FsIGlkIG9mIHRoZSBzdGFydGluZyBwcm9jZXNzIHRvIHRoZSB0YXJnZXQgdmFsdWUsIGRlZmF1bHQgYXMgdGhlIHBhcmFtIG5hbWVcbiAqIEBwYXJhbSB7b2JqZWN0fSB2YXJPb2wgLSBUYXJnZXQgdmFsdWUgb29sIG5vZGUuXG4gKiBAcGFyYW0ge29iamVjdH0gY29tcGlsZUNvbnRleHQgLSBDb21waWxhdGlvbiBjb250ZXh0LlxuICogQHByb3BlcnR5IHtzdHJpbmd9IGNvbXBpbGVDb250ZXh0LnRhcmdldE5hbWVcbiAqIEBwcm9wZXJ0eSB7VG9wb1NvcnR9IGNvbXBpbGVDb250ZXh0LnRvcG9Tb3J0XG4gKiBAcHJvcGVydHkge29iamVjdH0gY29tcGlsZUNvbnRleHQuYXN0TWFwIC0gVG9wbyBJZCB0byBhc3QgbWFwXG4gKiBAcmV0dXJucyB7c3RyaW5nfSBMYXN0IHRvcG8gSWRcbiAqL1xuZnVuY3Rpb24gY29tcGlsZVBpcGVkVmFsdWUoc3RhcnRUb3BvSWQsIHZhck9vbCwgY29tcGlsZUNvbnRleHQpIHtcbiAgICBsZXQgbGFzdFRvcG9JZCA9IGNvbXBpbGVDb25jcmV0ZVZhbHVlRXhwcmVzc2lvbihzdGFydFRvcG9JZCwgdmFyT29sLnZhbHVlLCBjb21waWxlQ29udGV4dCk7XG5cbiAgICB2YXJPb2wubW9kaWZpZXJzLmZvckVhY2gobW9kaWZpZXIgPT4ge1xuICAgICAgICBsZXQgbW9kaWZpZXJTdGFydFRvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgc3RhcnRUb3BvSWQgKyBPT0xfTU9ESUZJRVJfT1BbbW9kaWZpZXIub29sVHlwZV0gKyBtb2RpZmllci5uYW1lKTtcbiAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBsYXN0VG9wb0lkLCBtb2RpZmllclN0YXJ0VG9wb0lkKTtcblxuICAgICAgICBsYXN0VG9wb0lkID0gY29tcGlsZU1vZGlmaWVyKFxuICAgICAgICAgICAgbW9kaWZpZXJTdGFydFRvcG9JZCxcbiAgICAgICAgICAgIHZhck9vbC52YWx1ZSxcbiAgICAgICAgICAgIG1vZGlmaWVyLFxuICAgICAgICAgICAgY29tcGlsZUNvbnRleHRcbiAgICAgICAgKTtcbiAgICB9KTtcblxuICAgIHJldHVybiBsYXN0VG9wb0lkO1xufVxuXG4vKipcbiAqIENvbXBpbGUgYSB2YXJpYWJsZSByZWZlcmVuY2UgZnJvbSBvb2wgdG8gYXN0LlxuICogQHBhcmFtIHtzdHJpbmd9IHN0YXJ0VG9wb0lkIC0gVGhlIHRvcG9sb2dpY2FsIGlkIG9mIHRoZSBzdGFydGluZyBwcm9jZXNzIHRvIHRoZSB0YXJnZXQgdmFsdWUsIGRlZmF1bHQgYXMgdGhlIHBhcmFtIG5hbWVcbiAqIEBwYXJhbSB7b2JqZWN0fSB2YXJPb2wgLSBUYXJnZXQgdmFsdWUgb29sIG5vZGUuXG4gKiBAcGFyYW0ge29iamVjdH0gY29tcGlsZUNvbnRleHQgLSBDb21waWxhdGlvbiBjb250ZXh0LlxuICogQHByb3BlcnR5IHtzdHJpbmd9IGNvbXBpbGVDb250ZXh0LnRhcmdldE5hbWVcbiAqIEBwcm9wZXJ0eSB7VG9wb1NvcnR9IGNvbXBpbGVDb250ZXh0LnRvcG9Tb3J0XG4gKiBAcHJvcGVydHkge29iamVjdH0gY29tcGlsZUNvbnRleHQuYXN0TWFwIC0gVG9wbyBJZCB0byBhc3QgbWFwXG4gKiBAcmV0dXJucyB7c3RyaW5nfSBMYXN0IHRvcG8gSWRcbiAqL1xuZnVuY3Rpb24gY29tcGlsZVZhcmlhYmxlUmVmZXJlbmNlKHN0YXJ0VG9wb0lkLCB2YXJPb2wsIGNvbXBpbGVDb250ZXh0KSB7XG4gICAgcHJlOiBfLmlzUGxhaW5PYmplY3QodmFyT29sKSAmJiB2YXJPb2wub29sVHlwZSA9PT0gJ09iamVjdFJlZmVyZW5jZSc7XG5cbiAgICBsZXQgWyBiYXNlTmFtZSwgb3RoZXJzIF0gPSB2YXJPb2wubmFtZS5zcGxpdCgnLicsIDIpO1xuICAgIC8qXG4gICAgaWYgKGNvbXBpbGVDb250ZXh0Lm1vZGVsVmFycyAmJiBjb21waWxlQ29udGV4dC5tb2RlbFZhcnMuaGFzKGJhc2VOYW1lKSAmJiBvdGhlcnMpIHtcbiAgICAgICAgdmFyT29sLm5hbWUgPSBiYXNlTmFtZSArICcuZGF0YScgKyAnLicgKyBvdGhlcnM7XG4gICAgfSovICAgIFxuXG4gICAgLy9zaW1wbGUgdmFsdWVcbiAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbc3RhcnRUb3BvSWRdID0gSnNMYW5nLmFzdFZhbHVlKHZhck9vbCk7XG4gICAgcmV0dXJuIHN0YXJ0VG9wb0lkO1xufVxuXG4vKipcbiAqIEdldCBhbiBhcnJheSBvZiBwYXJhbWV0ZXIgbmFtZXMuXG4gKiBAcGFyYW0ge2FycmF5fSBhcmdzIC0gQW4gYXJyYXkgb2YgYXJndW1lbnRzIGluIG9vbCBzeW50YXhcbiAqIEByZXR1cm5zIHthcnJheX1cbiAqL1xuZnVuY3Rpb24gdHJhbnNsYXRlRnVuY3Rpb25QYXJhbXMoYXJncykge1xuICAgIGlmIChfLmlzRW1wdHkoYXJncykpIHJldHVybiBbXTtcblxuICAgIGxldCBuYW1lcyA9IG5ldyBTZXQoKTtcblxuICAgIGZ1bmN0aW9uIHRyYW5zbGF0ZUZ1bmN0aW9uUGFyYW0oYXJnLCBpKSB7XG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QoYXJnKSkge1xuICAgICAgICAgICAgaWYgKGFyZy5vb2xUeXBlID09PSAnUGlwZWRWYWx1ZScpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdHJhbnNsYXRlRnVuY3Rpb25QYXJhbShhcmcudmFsdWUpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoYXJnLm9vbFR5cGUgPT09ICdPYmplY3RSZWZlcmVuY2UnKSB7XG4gICAgICAgICAgICAgICAgaWYgKGlzRG90U2VwYXJhdGVOYW1lKGFyZy5uYW1lKSkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gZXh0cmFjdERvdFNlcGFyYXRlTmFtZShhcmcubmFtZSkucG9wKCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuXG4gICAgICAgICAgICByZXR1cm4gYXJnLm5hbWU7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gJ3BhcmFtJyArIChpICsgMSkudG9TdHJpbmcoKTtcbiAgICB9XG5cbiAgICByZXR1cm4gXy5tYXAoYXJncywgKGFyZywgaSkgPT4ge1xuICAgICAgICBsZXQgYmFzZU5hbWUgPSB0cmFuc2xhdGVGdW5jdGlvblBhcmFtKGFyZywgaSk7XG4gICAgICAgIGxldCBuYW1lID0gYmFzZU5hbWU7XG4gICAgICAgIGxldCBjb3VudCA9IDI7XG4gICAgICAgIFxuICAgICAgICB3aGlsZSAobmFtZXMuaGFzKG5hbWUpKSB7XG4gICAgICAgICAgICBuYW1lID0gYmFzZU5hbWUgKyBjb3VudC50b1N0cmluZygpO1xuICAgICAgICAgICAgY291bnQrKztcbiAgICAgICAgfVxuXG4gICAgICAgIG5hbWVzLmFkZChuYW1lKTtcbiAgICAgICAgcmV0dXJuIG5hbWU7ICAgICAgICBcbiAgICB9KTtcbn1cblxuLyoqXG4gKiBDb21waWxlIGEgY29uY3JldGUgdmFsdWUgZXhwcmVzc2lvbiBmcm9tIG9vbCB0byBhc3RcbiAqIEBwYXJhbSB7c3RyaW5nfSBzdGFydFRvcG9JZCAtIFRoZSB0b3BvIGlkIG9mIHRoZSBzdGFydGluZyBwcm9jZXNzIHRvIHRoZSB0YXJnZXQgdmFsdWUgZXhwcmVzc2lvblxuICogQHBhcmFtIHtvYmplY3R9IHZhbHVlIC0gT29sIG5vZGVcbiAqIEBwYXJhbSB7b2JqZWN0fSBjb21waWxlQ29udGV4dCAtIENvbXBpbGF0aW9uIGNvbnRleHRcbiAqIEByZXR1cm5zIHtzdHJpbmd9IExhc3QgdG9wb0lkXG4gKi9cbmZ1bmN0aW9uIGNvbXBpbGVDb25jcmV0ZVZhbHVlRXhwcmVzc2lvbihzdGFydFRvcG9JZCwgdmFsdWUsIGNvbXBpbGVDb250ZXh0KSB7XG4gICAgaWYgKF8uaXNQbGFpbk9iamVjdCh2YWx1ZSkpIHtcbiAgICAgICAgaWYgKHZhbHVlLm9vbFR5cGUgPT09ICdQaXBlZFZhbHVlJykge1xuICAgICAgICAgICAgcmV0dXJuIGNvbXBpbGVQaXBlZFZhbHVlKHN0YXJ0VG9wb0lkLCB2YWx1ZSwgY29tcGlsZUNvbnRleHQpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHZhbHVlLm9vbFR5cGUgPT09ICdPYmplY3RSZWZlcmVuY2UnKSB7XG4gICAgICAgICAgICBsZXQgWyByZWZCYXNlLCAuLi5yZXN0IF0gPSBleHRyYWN0RG90U2VwYXJhdGVOYW1lKHZhbHVlLm5hbWUpO1xuXG4gICAgICAgICAgICBsZXQgZGVwZW5kZW5jeTtcblxuICAgICAgICAgICAgaWYgKGNvbXBpbGVDb250ZXh0Lm1vZGVsVmFycyAmJiBjb21waWxlQ29udGV4dC5tb2RlbFZhcnMuaGFzKHJlZkJhc2UpKSB7XG4gICAgICAgICAgICAgICAgLy91c2VyLCB1c2VyLnBhc3N3b3JkIG9yIHVzZXIuZGF0YS5wYXNzd29yZFxuICAgICAgICAgICAgICAgIGRlcGVuZGVuY3kgPSByZWZCYXNlO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChyZWZCYXNlID09PSAnbGF0ZXN0JyAmJiByZXN0Lmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgICAgICAvL2xhdGVzdC5wYXNzd29yZFxuICAgICAgICAgICAgICAgIGxldCByZWZGaWVsZE5hbWUgPSByZXN0LnBvcCgpO1xuICAgICAgICAgICAgICAgIGlmIChyZWZGaWVsZE5hbWUgIT09IHN0YXJ0VG9wb0lkKSB7XG4gICAgICAgICAgICAgICAgICAgIGRlcGVuZGVuY3kgPSByZWZGaWVsZE5hbWUgKyAnOnJlYWR5JztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2UgaWYgKF8uaXNFbXB0eShyZXN0KSkge1xuICAgICAgICAgICAgICAgIGRlcGVuZGVuY3kgPSByZWZCYXNlICsgJzpyZWFkeSc7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5yZWNvZ25pemVkIG9iamVjdCByZWZlcmVuY2U6ICcgKyBKU09OLnN0cmluZ2lmeSh2YWx1ZSkpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoZGVwZW5kZW5jeSkge1xuICAgICAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgZGVwZW5kZW5jeSwgc3RhcnRUb3BvSWQpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gY29tcGlsZVZhcmlhYmxlUmVmZXJlbmNlKHN0YXJ0VG9wb0lkLCB2YWx1ZSwgY29tcGlsZUNvbnRleHQpO1xuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICB2YWx1ZSA9IF8ubWFwVmFsdWVzKHZhbHVlLCAodmFsdWVPZkVsZW1lbnQsIGtleSkgPT4geyBcbiAgICAgICAgICAgIGxldCBzaWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkICsgJy4nICsga2V5KTtcbiAgICAgICAgICAgIGxldCBlaWQgPSBjb21waWxlQ29uY3JldGVWYWx1ZUV4cHJlc3Npb24oc2lkLCB2YWx1ZU9mRWxlbWVudCwgY29tcGlsZUNvbnRleHQpO1xuICAgICAgICAgICAgaWYgKHNpZCAhPT0gZWlkKSB7XG4gICAgICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBlaWQsIHN0YXJ0VG9wb0lkKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiBjb21waWxlQ29udGV4dC5hc3RNYXBbZWlkXTtcbiAgICAgICAgfSk7XG4gICAgfSBlbHNlIGlmIChBcnJheS5pc0FycmF5KHZhbHVlKSkge1xuICAgICAgICB2YWx1ZSA9IF8ubWFwKHZhbHVlLCAodmFsdWVPZkVsZW1lbnQsIGluZGV4KSA9PiB7IFxuICAgICAgICAgICAgbGV0IHNpZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgc3RhcnRUb3BvSWQgKyAnWycgKyBpbmRleCArICddJyk7XG4gICAgICAgICAgICBsZXQgZWlkID0gY29tcGlsZUNvbmNyZXRlVmFsdWVFeHByZXNzaW9uKHNpZCwgdmFsdWVPZkVsZW1lbnQsIGNvbXBpbGVDb250ZXh0KTtcbiAgICAgICAgICAgIGlmIChzaWQgIT09IGVpZCkge1xuICAgICAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgZWlkLCBzdGFydFRvcG9JZCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gY29tcGlsZUNvbnRleHQuYXN0TWFwW2VpZF07XG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtzdGFydFRvcG9JZF0gPSBKc0xhbmcuYXN0VmFsdWUodmFsdWUpO1xuICAgIHJldHVybiBzdGFydFRvcG9JZDtcbn1cblxuLyoqXG4gKiBUcmFuc2xhdGUgYW4gYXJyYXkgb2YgZnVuY3Rpb24gYXJndW1lbnRzIGZyb20gb29sIGludG8gYXN0LlxuICogQHBhcmFtIHRvcG9JZCAtIFRoZSBtb2RpZmllciBmdW5jdGlvbiB0b3BvIFxuICogQHBhcmFtIGFyZ3MgLSBcbiAqIEBwYXJhbSBjb21waWxlQ29udGV4dCAtIFxuICogQHJldHVybnMge0FycmF5fVxuICovXG5mdW5jdGlvbiB0cmFuc2xhdGVBcmdzKHRvcG9JZCwgYXJncywgY29tcGlsZUNvbnRleHQpIHtcbiAgICBhcmdzID0gXy5jYXN0QXJyYXkoYXJncyk7XG4gICAgaWYgKF8uaXNFbXB0eShhcmdzKSkgcmV0dXJuIFtdO1xuXG4gICAgbGV0IGNhbGxBcmdzID0gW107XG5cbiAgICBfLmVhY2goYXJncywgKGFyZywgaSkgPT4geyAgICAgICAgICAgICAgICBcbiAgICAgICAgbGV0IGFyZ1RvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgdG9wb0lkICsgJzphcmdbJyArIChpKzEpLnRvU3RyaW5nKCkgKyAnXScpO1xuICAgICAgICBsZXQgbGFzdFRvcG9JZCA9IGNvbXBpbGVDb25jcmV0ZVZhbHVlRXhwcmVzc2lvbihhcmdUb3BvSWQsIGFyZywgY29tcGlsZUNvbnRleHQpO1xuXG4gICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgbGFzdFRvcG9JZCwgdG9wb0lkKTtcblxuICAgICAgICBjYWxsQXJncyA9IGNhbGxBcmdzLmNvbmNhdChfLmNhc3RBcnJheShnZXRDb2RlUmVwcmVzZW50YXRpb25PZihsYXN0VG9wb0lkLCBjb21waWxlQ29udGV4dCkpKTtcbiAgICB9KTtcblxuICAgIHJldHVybiBjYWxsQXJncztcbn1cblxuLyoqXG4gKiBDb21waWxlIGEgcGFyYW0gb2YgaW50ZXJmYWNlIGZyb20gb29sIGludG8gYXN0XG4gKiBAcGFyYW0gaW5kZXhcbiAqIEBwYXJhbSBwYXJhbVxuICogQHBhcmFtIGNvbXBpbGVDb250ZXh0XG4gKiBAcmV0dXJucyB7c3RyaW5nfVxuICovXG5mdW5jdGlvbiBjb21waWxlUGFyYW0oaW5kZXgsIHBhcmFtLCBjb21waWxlQ29udGV4dCkge1xuICAgIGxldCB0eXBlID0gcGFyYW0udHlwZTsgICAgXG5cbiAgICBsZXQgdHlwZU9iamVjdCA9IFR5cGVzW3R5cGVdO1xuXG4gICAgaWYgKCF0eXBlT2JqZWN0KSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcignVW5rbm93biBmaWVsZCB0eXBlOiAnICsgdHlwZSk7XG4gICAgfVxuXG4gICAgbGV0IHNhbml0aXplck5hbWUgPSBgVHlwZXMuJHt0eXBlLnRvVXBwZXJDYXNlKCl9LnNhbml0aXplYDtcblxuICAgIGxldCB2YXJSZWYgPSBKc0xhbmcuYXN0VmFyUmVmKHBhcmFtLm5hbWUpO1xuICAgIGxldCBjYWxsQXN0ID0gSnNMYW5nLmFzdENhbGwoc2FuaXRpemVyTmFtZSwgW3ZhclJlZiwgSnNMYW5nLmFzdEFycmF5QWNjZXNzKCckbWV0YS5wYXJhbXMnLCBpbmRleCksIEpzTGFuZy5hc3RWYXJSZWYoJ3RoaXMuZGIuaTE4bicpXSk7XG5cbiAgICBsZXQgcHJlcGFyZVRvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgJyRwYXJhbXM6c2FuaXRpemVbJyArIGluZGV4LnRvU3RyaW5nKCkgKyAnXScpO1xuICAgIC8vbGV0IHNhbml0aXplU3RhcnRpbmc7XG5cbiAgICAvL2lmIChpbmRleCA9PT0gMCkge1xuICAgICAgICAvL2RlY2xhcmUgJHNhbml0aXplU3RhdGUgdmFyaWFibGUgZm9yIHRoZSBmaXJzdCB0aW1lXG4gICAgLy8gICAgc2FuaXRpemVTdGFydGluZyA9IEpzTGFuZy5hc3RWYXJEZWNsYXJlKHZhclJlZiwgY2FsbEFzdCwgZmFsc2UsIGZhbHNlLCBgU2FuaXRpemUgcGFyYW0gXCIke3BhcmFtLm5hbWV9XCJgKTtcbiAgICAvL30gZWxzZSB7XG4gICAgLy9sZXQgc2FuaXRpemVTdGFydGluZyA9IDtcblxuICAgICAgICAvL2xldCBsYXN0UHJlcGFyZVRvcG9JZCA9ICckcGFyYW1zOnNhbml0aXplWycgKyAoaW5kZXggLSAxKS50b1N0cmluZygpICsgJ10nO1xuICAgICAgICAvL2RlcGVuZHNPbihjb21waWxlQ29udGV4dCwgbGFzdFByZXBhcmVUb3BvSWQsIHByZXBhcmVUb3BvSWQpO1xuICAgIC8vfVxuXG4gICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW3ByZXBhcmVUb3BvSWRdID0gW1xuICAgICAgICBKc0xhbmcuYXN0QXNzaWduKHZhclJlZiwgY2FsbEFzdCwgYFNhbml0aXplIGFyZ3VtZW50IFwiJHtwYXJhbS5uYW1lfVwiYClcbiAgICBdO1xuXG4gICAgYWRkQ29kZUJsb2NrKGNvbXBpbGVDb250ZXh0LCBwcmVwYXJlVG9wb0lkLCB7XG4gICAgICAgIHR5cGU6IEFTVF9CTEtfUEFSQU1fU0FOSVRJWkVcbiAgICB9KTtcblxuICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgcHJlcGFyZVRvcG9JZCwgY29tcGlsZUNvbnRleHQubWFpblN0YXJ0SWQpO1xuXG4gICAgbGV0IHRvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgcGFyYW0ubmFtZSk7XG4gICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBjb21waWxlQ29udGV4dC5tYWluU3RhcnRJZCwgdG9wb0lkKTtcblxuICAgIGxldCB2YWx1ZSA9IHdyYXBQYXJhbVJlZmVyZW5jZShwYXJhbS5uYW1lLCBwYXJhbSk7XG4gICAgbGV0IGVuZFRvcG9JZCA9IGNvbXBpbGVWYXJpYWJsZVJlZmVyZW5jZSh0b3BvSWQsIHZhbHVlLCBjb21waWxlQ29udGV4dCk7XG5cbiAgICBsZXQgcmVhZHlUb3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIHRvcG9JZCArICc6cmVhZHknKTtcbiAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIGVuZFRvcG9JZCwgcmVhZHlUb3BvSWQpO1xuXG4gICAgcmV0dXJuIHJlYWR5VG9wb0lkO1xufVxuXG4vKipcbiAqIENvbXBpbGUgYSBtb2RlbCBmaWVsZCBwcmVwcm9jZXNzIGluZm9ybWF0aW9uIGludG8gYXN0LlxuICogQHBhcmFtIHtvYmplY3R9IHBhcmFtIC0gRmllbGQgaW5mb3JtYXRpb25cbiAqIEBwYXJhbSB7b2JqZWN0fSBjb21waWxlQ29udGV4dCAtIENvbXBpbGF0aW9uIGNvbnRleHRcbiAqIEByZXR1cm5zIHtzdHJpbmd9XG4gKi9cbmZ1bmN0aW9uIGNvbXBpbGVGaWVsZChwYXJhbU5hbWUsIHBhcmFtLCBjb21waWxlQ29udGV4dCkge1xuICAgIC8vIDEuIHJlZmVyZW5jZSB0byB0aGUgbGF0ZXN0IG9iamVjdCB0aGF0IGlzIHBhc3NlZCBxdWFsaWZpZXIgY2hlY2tzXG4gICAgLy8gMi4gaWYgbW9kaWZpZXJzIGV4aXN0LCB3cmFwIHRoZSByZWYgaW50byBhIHBpcGVkIHZhbHVlXG4gICAgLy8gMy4gcHJvY2VzcyB0aGUgcmVmIChvciBwaXBlZCByZWYpIGFuZCBtYXJrIGFzIGVuZFxuICAgIC8vIDQuIGJ1aWxkIGRlcGVuZGVuY2llczogbGF0ZXN0LmZpZWxkIC0+IC4uLiAtPiBmaWVsZDpyZWFkeSBcbiAgICBsZXQgdG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBwYXJhbU5hbWUpO1xuICAgIGxldCBjb250ZXh0TmFtZSA9ICdsYXRlc3QuJyArIHBhcmFtTmFtZTtcbiAgICAvL2NvbXBpbGVDb250ZXh0LmFzdE1hcFt0b3BvSWRdID0gSnNMYW5nLmFzdFZhclJlZihjb250ZXh0TmFtZSwgdHJ1ZSk7XG5cbiAgICBsZXQgdmFsdWUgPSB3cmFwUGFyYW1SZWZlcmVuY2UoY29udGV4dE5hbWUsIHBhcmFtKTsgICAgXG4gICAgbGV0IGVuZFRvcG9JZCA9IGNvbXBpbGVDb25jcmV0ZVZhbHVlRXhwcmVzc2lvbih0b3BvSWQsIHZhbHVlLCBjb21waWxlQ29udGV4dCk7XG5cbiAgICBsZXQgcmVhZHlUb3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIHRvcG9JZCArICc6cmVhZHknKTtcbiAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIGVuZFRvcG9JZCwgcmVhZHlUb3BvSWQpO1xuXG4gICAgcmV0dXJuIHJlYWR5VG9wb0lkO1xufVxuXG5mdW5jdGlvbiB3cmFwUGFyYW1SZWZlcmVuY2UobmFtZSwgdmFsdWUpIHtcbiAgICBsZXQgcmVmID0gT2JqZWN0LmFzc2lnbih7IG9vbFR5cGU6ICdPYmplY3RSZWZlcmVuY2UnLCBuYW1lOiBuYW1lIH0pO1xuICAgIFxuICAgIGlmICghXy5pc0VtcHR5KHZhbHVlLm1vZGlmaWVycykpIHtcbiAgICAgICAgcmV0dXJuIHsgb29sVHlwZTogJ1BpcGVkVmFsdWUnLCB2YWx1ZTogcmVmLCBtb2RpZmllcnM6IHZhbHVlLm1vZGlmaWVycyB9O1xuICAgIH1cbiAgICBcbiAgICByZXR1cm4gcmVmO1xufVxuXG4vKipcbiAqIFRyYW5zbGF0ZSBhIHRoZW4gY2xhdXNlIGZyb20gb29sIGludG8gYXN0XG4gKiBAcGFyYW0ge3N0cmluZ30gc3RhcnRJZFxuICogQHBhcmFtIHtzdHJpbmd9IGVuZElkXG4gKiBAcGFyYW0gdGhlblxuICogQHBhcmFtIGNvbXBpbGVDb250ZXh0XG4gKiBAcGFyYW0gYXNzaWduVG9cbiAqIEByZXR1cm5zIHtvYmplY3R9IEFTVCBvYmplY3RcbiAqL1xuZnVuY3Rpb24gdHJhbnNsYXRlVGhlbkFzdChzdGFydElkLCBlbmRJZCwgdGhlbiwgY29tcGlsZUNvbnRleHQsIGFzc2lnblRvKSB7XG4gICAgaWYgKF8uaXNQbGFpbk9iamVjdCh0aGVuKSkge1xuICAgICAgICBpZiAodGhlbi5vb2xUeXBlID09PSAnVGhyb3dFeHByZXNzaW9uJykge1xuICAgICAgICAgICAgcmV0dXJuIEpzTGFuZy5hc3RUaHJvdyh0aGVuLmVycm9yVHlwZSB8fCBkZWZhdWx0RXJyb3IsIHRoZW4ubWVzc2FnZSB8fCBbXSk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAodGhlbi5vb2xUeXBlID09PSAnUmV0dXJuRXhwcmVzc2lvbicpIHtcbiAgICAgICAgICAgIHJldHVybiB0cmFuc2xhdGVSZXR1cm5WYWx1ZUFzdChzdGFydElkLCBlbmRJZCwgdGhlbi52YWx1ZSwgY29tcGlsZUNvbnRleHQpO1xuICAgICAgICB9ICAgICAgICBcbiAgICB9XG5cbiAgICAvL3RoZW4gZXhwcmVzc2lvbiBpcyBhbiBvb2xvbmcgY29uY3JldGUgdmFsdWUgICAgXG4gICAgaWYgKF8uaXNBcnJheSh0aGVuKSB8fCBfLmlzUGxhaW5PYmplY3QodGhlbikpIHtcbiAgICAgICAgbGV0IHZhbHVlRW5kSWQgPSBjb21waWxlQ29uY3JldGVWYWx1ZUV4cHJlc3Npb24oc3RhcnRJZCwgdGhlbiwgY29tcGlsZUNvbnRleHQpOyAgICBcbiAgICAgICAgdGhlbiA9IGNvbXBpbGVDb250ZXh0LmFzdE1hcFt2YWx1ZUVuZElkXTsgXG4gICAgfSAgIFxuXG4gICAgaWYgKCFhc3NpZ25Ubykge1xuICAgICAgICByZXR1cm4gSnNMYW5nLmFzdFJldHVybih0aGVuKTtcbiAgICB9XG5cbiAgICByZXR1cm4gSnNMYW5nLmFzdEFzc2lnbihhc3NpZ25UbywgdGhlbik7XG59XG5cbi8qKlxuICogVHJhbnNsYXRlIGEgcmV0dXJuIGNsYXVzZSBmcm9tIG9vbCBpbnRvIGFzdFxuICogQHBhcmFtIHtzdHJpbmd9IHN0YXJ0VG9wb0lkIC0gVGhlIHRvcG8gaWQgb2YgdGhlIHN0YXJ0aW5nIHN0YXRlIG9mIHJldHVybiBjbGF1c2VcbiAqIEBwYXJhbSB7c3RyaW5nfSBlbmRUb3BvSWQgLSBUaGUgdG9wbyBpZCBvZiB0aGUgZW5kaW5nIHN0YXRlIG9mIHJldHVybiBjbGF1c2VcbiAqIEBwYXJhbSB2YWx1ZVxuICogQHBhcmFtIGNvbXBpbGVDb250ZXh0XG4gKiBAcmV0dXJucyB7b2JqZWN0fSBBU1Qgb2JqZWN0XG4gKi9cbmZ1bmN0aW9uIHRyYW5zbGF0ZVJldHVyblZhbHVlQXN0KHN0YXJ0VG9wb0lkLCBlbmRUb3BvSWQsIHZhbHVlLCBjb21waWxlQ29udGV4dCkge1xuICAgIGxldCB2YWx1ZVRvcG9JZCA9IGNvbXBpbGVDb25jcmV0ZVZhbHVlRXhwcmVzc2lvbihzdGFydFRvcG9JZCwgdmFsdWUsIGNvbXBpbGVDb250ZXh0KTtcbiAgICBpZiAodmFsdWVUb3BvSWQgIT09IHN0YXJ0VG9wb0lkKSB7XG4gICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgdmFsdWVUb3BvSWQsIGVuZFRvcG9JZCk7XG4gICAgfVxuXG4gICAgcmV0dXJuIEpzTGFuZy5hc3RSZXR1cm4oZ2V0Q29kZVJlcHJlc2VudGF0aW9uT2YodmFsdWVUb3BvSWQsIGNvbXBpbGVDb250ZXh0KSk7XG59XG5cbi8qKlxuICogQ29tcGlsZSBhIHJldHVybiBjbGF1c2UgZnJvbSBvb2wgaW50byBhc3RcbiAqIEBwYXJhbSB7c3RyaW5nfSBzdGFydFRvcG9JZCAtIFRoZSB0b3BvIGlkIG9mIHRoZSBzdGFydGluZyBwcm9jZXNzIHRvIHRoZSB0YXJnZXQgdmFsdWUgZXhwcmVzc2lvblxuICogQHBhcmFtIHZhbHVlXG4gKiBAcGFyYW0gY29tcGlsZUNvbnRleHRcbiAqIEByZXR1cm5zIHtvYmplY3R9IEFTVCBvYmplY3RcbiAqL1xuZnVuY3Rpb24gY29tcGlsZVJldHVybihzdGFydFRvcG9JZCwgdmFsdWUsIGNvbXBpbGVDb250ZXh0KSB7XG4gICAgbGV0IGVuZFRvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgJyRyZXR1cm4nKTtcbiAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkLCBlbmRUb3BvSWQpO1xuXG4gICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW2VuZFRvcG9JZF0gPSB0cmFuc2xhdGVSZXR1cm5WYWx1ZUFzdChzdGFydFRvcG9JZCwgZW5kVG9wb0lkLCB2YWx1ZSwgY29tcGlsZUNvbnRleHQpO1xuXG4gICAgYWRkQ29kZUJsb2NrKGNvbXBpbGVDb250ZXh0LCBlbmRUb3BvSWQsIHtcbiAgICAgICAgdHlwZTogQVNUX0JMS19WSUVXX1JFVFVSTlxuICAgIH0pO1xuXG4gICAgcmV0dXJuIGVuZFRvcG9JZDtcbn1cblxuLyoqXG4gKiBDb21waWxlIGEgZmluZCBvbmUgb3BlcmF0aW9uIGZyb20gb29sIGludG8gYXN0XG4gKiBAcGFyYW0ge2ludH0gaW5kZXhcbiAqIEBwYXJhbSB7b2JqZWN0fSBvcGVyYXRpb24gLSBPb2wgbm9kZVxuICogQHBhcmFtIHtvYmplY3R9IGNvbXBpbGVDb250ZXh0IC1cbiAqIEBwYXJhbSB7c3RyaW5nfSBkZXBlbmRlbmN5XG4gKiBAcmV0dXJucyB7c3RyaW5nfSBsYXN0IHRvcG9JZFxuICovXG5mdW5jdGlvbiBjb21waWxlRmluZE9uZShpbmRleCwgb3BlcmF0aW9uLCBjb21waWxlQ29udGV4dCwgZGVwZW5kZW5jeSkge1xuICAgIHByZTogZGVwZW5kZW5jeTtcblxuICAgIGxldCBlbmRUb3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsICdvcCQnICsgaW5kZXgudG9TdHJpbmcoKSk7XG4gICAgbGV0IGNvbmRpdGlvblZhck5hbWUgPSBlbmRUb3BvSWQgKyAnJGNvbmRpdGlvbic7XG5cbiAgICBsZXQgYXN0ID0gW1xuICAgICAgICBKc0xhbmcuYXN0VmFyRGVjbGFyZShjb25kaXRpb25WYXJOYW1lKVxuICAgIF07XG5cbiAgICBhc3NlcnQ6IG9wZXJhdGlvbi5jb25kaXRpb247XG5cbiAgICBpZiAob3BlcmF0aW9uLmNvbmRpdGlvbi5vb2xUeXBlKSB7XG4gICAgICAgIC8vc3BlY2lhbCBjb25kaXRpb25cblxuICAgICAgICBpZiAob3BlcmF0aW9uLmNvbmRpdGlvbi5vb2xUeXBlID09PSAnY2FzZXMnKSB7XG4gICAgICAgICAgICBsZXQgdG9wb0lkUHJlZml4ID0gZW5kVG9wb0lkICsgJyRjYXNlcyc7XG4gICAgICAgICAgICBsZXQgbGFzdFN0YXRlbWVudDtcblxuICAgICAgICAgICAgaWYgKG9wZXJhdGlvbi5jb25kaXRpb24uZWxzZSkge1xuICAgICAgICAgICAgICAgIGxldCBlbHNlU3RhcnQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIHRvcG9JZFByZWZpeCArICc6ZWxzZScpO1xuICAgICAgICAgICAgICAgIGxldCBlbHNlRW5kID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCB0b3BvSWRQcmVmaXggKyAnOmVuZCcpO1xuICAgICAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgZWxzZVN0YXJ0LCBlbHNlRW5kKTtcbiAgICAgICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIGVsc2VFbmQsIGVuZFRvcG9JZCk7XG5cbiAgICAgICAgICAgICAgICBsYXN0U3RhdGVtZW50ID0gdHJhbnNsYXRlVGhlbkFzdChlbHNlU3RhcnQsIGVsc2VFbmQsIG9wZXJhdGlvbi5jb25kaXRpb24uZWxzZSwgY29tcGlsZUNvbnRleHQsIGNvbmRpdGlvblZhck5hbWUpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBsYXN0U3RhdGVtZW50ID0gSnNMYW5nLmFzdFRocm93KCdTZXJ2ZXJFcnJvcicsICdVbmV4cGVjdGVkIHN0YXRlLicpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoXy5pc0VtcHR5KG9wZXJhdGlvbi5jb25kaXRpb24uaXRlbXMpKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdNaXNzaW5nIGNhc2UgaXRlbXMnKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgXy5yZXZlcnNlKG9wZXJhdGlvbi5jb25kaXRpb24uaXRlbXMpLmZvckVhY2goKGl0ZW0sIGkpID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoaXRlbS5vb2xUeXBlICE9PSAnQ29uZGl0aW9uYWxTdGF0ZW1lbnQnKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignSW52YWxpZCBjYXNlIGl0ZW0uJyk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaSA9IG9wZXJhdGlvbi5jb25kaXRpb24uaXRlbXMubGVuZ3RoIC0gaSAtIDE7XG5cbiAgICAgICAgICAgICAgICBsZXQgY2FzZVByZWZpeCA9IHRvcG9JZFByZWZpeCArICdbJyArIGkudG9TdHJpbmcoKSArICddJztcbiAgICAgICAgICAgICAgICBsZXQgY2FzZVRvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgY2FzZVByZWZpeCk7XG4gICAgICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBkZXBlbmRlbmN5LCBjYXNlVG9wb0lkKTtcblxuICAgICAgICAgICAgICAgIGxldCBjYXNlUmVzdWx0VmFyTmFtZSA9ICckJyArIHRvcG9JZFByZWZpeCArICdfJyArIGkudG9TdHJpbmcoKTtcblxuICAgICAgICAgICAgICAgIGxldCBsYXN0VG9wb0lkID0gY29tcGlsZUNvbmRpdGlvbmFsRXhwcmVzc2lvbihpdGVtLnRlc3QsIGNvbXBpbGVDb250ZXh0LCBjYXNlVG9wb0lkKTtcbiAgICAgICAgICAgICAgICBsZXQgYXN0Q2FzZVR0ZW0gPSBnZXRDb2RlUmVwcmVzZW50YXRpb25PZihsYXN0VG9wb0lkLCBjb21waWxlQ29udGV4dCk7XG5cbiAgICAgICAgICAgICAgICBhc3NlcnQ6ICFBcnJheS5pc0FycmF5KGFzdENhc2VUdGVtKSwgJ0ludmFsaWQgY2FzZSBpdGVtIGFzdC4nO1xuXG4gICAgICAgICAgICAgICAgYXN0Q2FzZVR0ZW0gPSBKc0xhbmcuYXN0VmFyRGVjbGFyZShjYXNlUmVzdWx0VmFyTmFtZSwgYXN0Q2FzZVR0ZW0sIHRydWUsIGZhbHNlLCBgQ29uZGl0aW9uICR7aX0gZm9yIGZpbmQgb25lICR7b3BlcmF0aW9uLm1vZGVsfWApO1xuXG4gICAgICAgICAgICAgICAgbGV0IGlmU3RhcnQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIGNhc2VQcmVmaXggKyAnOnRoZW4nKTtcbiAgICAgICAgICAgICAgICBsZXQgaWZFbmQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIGNhc2VQcmVmaXggKyAnOmVuZCcpO1xuICAgICAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgbGFzdFRvcG9JZCwgaWZTdGFydCk7XG4gICAgICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBpZlN0YXJ0LCBpZkVuZCk7XG5cbiAgICAgICAgICAgICAgICBsYXN0U3RhdGVtZW50ID0gW1xuICAgICAgICAgICAgICAgICAgICBhc3RDYXNlVHRlbSxcbiAgICAgICAgICAgICAgICAgICAgSnNMYW5nLmFzdElmKEpzTGFuZy5hc3RWYXJSZWYoY2FzZVJlc3VsdFZhck5hbWUpLCBKc0xhbmcuYXN0QmxvY2sodHJhbnNsYXRlVGhlbkFzdChpZlN0YXJ0LCBpZkVuZCwgaXRlbS50aGVuLCBjb21waWxlQ29udGV4dCwgY29uZGl0aW9uVmFyTmFtZSkpLCBsYXN0U3RhdGVtZW50KVxuICAgICAgICAgICAgICAgIF07XG4gICAgICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBpZkVuZCwgZW5kVG9wb0lkKTtcbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICBhc3QgPSBhc3QuY29uY2F0KF8uY2FzdEFycmF5KGxhc3RTdGF0ZW1lbnQpKTtcbiAgICAgICAgfVxuXG5cbiAgICB9XG5cbiAgICBhc3QucHVzaChcbiAgICAgICAgSnNMYW5nLmFzdFZhckRlY2xhcmUob3BlcmF0aW9uLm1vZGVsLCBKc0xhbmcuYXN0QXdhaXQoYHRoaXMuZmluZE9uZV9gLCBKc0xhbmcuYXN0VmFyUmVmKGNvbmRpdGlvblZhck5hbWUpKSlcbiAgICApO1xuXG4gICAgbGV0IG1vZGVsVG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBvcGVyYXRpb24ubW9kZWwpO1xuICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgZW5kVG9wb0lkLCBtb2RlbFRvcG9JZCk7XG4gICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW2VuZFRvcG9JZF0gPSBhc3Q7XG4gICAgcmV0dXJuIGVuZFRvcG9JZDtcbn1cblxuZnVuY3Rpb24gY29tcGlsZURiT3BlcmF0aW9uKGluZGV4LCBvcGVyYXRpb24sIGNvbXBpbGVDb250ZXh0LCBkZXBlbmRlbmN5KSB7XG4gICAgbGV0IGxhc3RUb3BvSWQ7XG5cbiAgICBzd2l0Y2ggKG9wZXJhdGlvbi5vb2xUeXBlKSB7XG4gICAgICAgIGNhc2UgJ2ZpbmRPbmUnOlxuICAgICAgICAgICAgbGFzdFRvcG9JZCA9IGNvbXBpbGVGaW5kT25lKGluZGV4LCBvcGVyYXRpb24sIGNvbXBpbGVDb250ZXh0LCBkZXBlbmRlbmN5KTtcbiAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgIGNhc2UgJ2ZpbmQnOlxuICAgICAgICAgICAgLy9wcmVwYXJlRGJDb25uZWN0aW9uKGNvbXBpbGVDb250ZXh0KTtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcigndGJpJyk7XG4gICAgICAgICAgICBicmVhaztcblxuICAgICAgICBjYXNlICd1cGRhdGUnOlxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCd0YmknKTtcbiAgICAgICAgICAgIC8vcHJlcGFyZURiQ29ubmVjdGlvbihjb21waWxlQ29udGV4dCk7XG4gICAgICAgICAgICBicmVhaztcblxuICAgICAgICBjYXNlICdjcmVhdGUnOlxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCd0YmknKTtcbiAgICAgICAgICAgIC8vcHJlcGFyZURiQ29ubmVjdGlvbihjb21waWxlQ29udGV4dCk7XG4gICAgICAgICAgICBicmVhaztcblxuICAgICAgICBjYXNlICdkZWxldGUnOlxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCd0YmknKTtcbiAgICAgICAgICAgIC8vcHJlcGFyZURiQ29ubmVjdGlvbihjb21waWxlQ29udGV4dCk7XG4gICAgICAgICAgICBicmVhaztcblxuICAgICAgICBjYXNlICdqYXZhc2NyaXB0JzpcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcigndGJpJyk7XG4gICAgICAgICAgICBicmVhaztcblxuICAgICAgICBjYXNlICdhc3NpZ25tZW50JzpcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcigndGJpJyk7XG4gICAgICAgICAgICBicmVhaztcblxuICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbnN1cHBvcnRlZCBvcGVyYXRpb24gdHlwZTogJyArIG9wZXJhdGlvbi50eXBlKTtcbiAgICB9XG5cbiAgICBhZGRDb2RlQmxvY2soY29tcGlsZUNvbnRleHQsIGxhc3RUb3BvSWQsIHtcbiAgICAgICAgdHlwZTogQVNUX0JMS19JTlRFUkZBQ0VfT1BFUkFUSU9OXG4gICAgfSk7XG5cbiAgICByZXR1cm4gbGFzdFRvcG9JZDtcbn1cblxuLyoqXG4gKiBDb21waWxlIGV4Y2VwdGlvbmFsIHJldHVybiBcbiAqIEBwYXJhbSB7b2JqZWN0fSBvb2xOb2RlXG4gKiBAcGFyYW0ge29iamVjdH0gY29tcGlsZUNvbnRleHRcbiAqIEBwYXJhbSB7c3RyaW5nfSBbZGVwZW5kZW5jeV1cbiAqIEByZXR1cm5zIHtzdHJpbmd9IGxhc3QgdG9wb0lkXG4gKi9cbmZ1bmN0aW9uIGNvbXBpbGVFeGNlcHRpb25hbFJldHVybihvb2xOb2RlLCBjb21waWxlQ29udGV4dCwgZGVwZW5kZW5jeSkge1xuICAgIHByZTogKF8uaXNQbGFpbk9iamVjdChvb2xOb2RlKSAmJiBvb2xOb2RlLm9vbFR5cGUgPT09ICdSZXR1cm5FeHByZXNzaW9uJyk7XG5cbiAgICBsZXQgZW5kVG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCAnJHJldHVybicpLCBsYXN0RXhjZXB0aW9uSWQgPSBkZXBlbmRlbmN5O1xuXG4gICAgaWYgKCFfLmlzRW1wdHkob29sTm9kZS5leGNlcHRpb25zKSkge1xuICAgICAgICBvb2xOb2RlLmV4Y2VwdGlvbnMuZm9yRWFjaCgoaXRlbSwgaSkgPT4ge1xuICAgICAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChpdGVtKSkge1xuICAgICAgICAgICAgICAgIGlmIChpdGVtLm9vbFR5cGUgIT09ICdDb25kaXRpb25hbFN0YXRlbWVudCcpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbnN1cHBvcnRlZCBleGNlcHRpb25hbCB0eXBlOiAnICsgaXRlbS5vb2xUeXBlKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBsZXQgZXhjZXB0aW9uU3RhcnRJZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgZW5kVG9wb0lkICsgJzpleGNlcHRbJyArIGkudG9TdHJpbmcoKSArICddJyk7XG4gICAgICAgICAgICAgICAgbGV0IGV4Y2VwdGlvbkVuZElkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBlbmRUb3BvSWQgKyAnOmV4Y2VwdFsnICsgaS50b1N0cmluZygpICsgJ106ZG9uZScpO1xuICAgICAgICAgICAgICAgIGlmIChsYXN0RXhjZXB0aW9uSWQpIHtcbiAgICAgICAgICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBsYXN0RXhjZXB0aW9uSWQsIGV4Y2VwdGlvblN0YXJ0SWQpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGxldCBsYXN0VG9wb0lkID0gY29tcGlsZUNvbmRpdGlvbmFsRXhwcmVzc2lvbihpdGVtLnRlc3QsIGNvbXBpbGVDb250ZXh0LCBleGNlcHRpb25TdGFydElkKTtcblxuICAgICAgICAgICAgICAgIGxldCB0aGVuU3RhcnRJZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgZXhjZXB0aW9uU3RhcnRJZCArICc6dGhlbicpO1xuICAgICAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgbGFzdFRvcG9JZCwgdGhlblN0YXJ0SWQpO1xuICAgICAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgdGhlblN0YXJ0SWQsIGV4Y2VwdGlvbkVuZElkKTtcblxuICAgICAgICAgICAgICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtleGNlcHRpb25FbmRJZF0gPSBKc0xhbmcuYXN0SWYoXG4gICAgICAgICAgICAgICAgICAgIGdldENvZGVSZXByZXNlbnRhdGlvbk9mKGxhc3RUb3BvSWQsIGNvbXBpbGVDb250ZXh0KSxcbiAgICAgICAgICAgICAgICAgICAgSnNMYW5nLmFzdEJsb2NrKHRyYW5zbGF0ZVRoZW5Bc3QoXG4gICAgICAgICAgICAgICAgICAgICAgICB0aGVuU3RhcnRJZCxcbiAgICAgICAgICAgICAgICAgICAgICAgIGV4Y2VwdGlvbkVuZElkLFxuICAgICAgICAgICAgICAgICAgICAgICAgaXRlbS50aGVuLCBjb21waWxlQ29udGV4dCkpLFxuICAgICAgICAgICAgICAgICAgICBudWxsLFxuICAgICAgICAgICAgICAgICAgICBgUmV0dXJuIG9uIGV4Y2VwdGlvbiAjJHtpfWBcbiAgICAgICAgICAgICAgICApO1xuXG4gICAgICAgICAgICAgICAgYWRkQ29kZUJsb2NrKGNvbXBpbGVDb250ZXh0LCBleGNlcHRpb25FbmRJZCwge1xuICAgICAgICAgICAgICAgICAgICB0eXBlOiBBU1RfQkxLX0VYQ0VQVElPTl9JVEVNXG4gICAgICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgICAgICBsYXN0RXhjZXB0aW9uSWQgPSBleGNlcHRpb25FbmRJZDtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbmV4cGVjdGVkLicpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIGxhc3RFeGNlcHRpb25JZCwgZW5kVG9wb0lkKTtcblxuICAgIGxldCByZXR1cm5TdGFydFRvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgJyRyZXR1cm46dmFsdWUnKTtcbiAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIHJldHVyblN0YXJ0VG9wb0lkLCBlbmRUb3BvSWQpO1xuXG4gICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW2VuZFRvcG9JZF0gPSB0cmFuc2xhdGVSZXR1cm5WYWx1ZUFzdChyZXR1cm5TdGFydFRvcG9JZCwgZW5kVG9wb0lkLCBvb2xOb2RlLnZhbHVlLCBjb21waWxlQ29udGV4dCk7XG5cbiAgICBhZGRDb2RlQmxvY2soY29tcGlsZUNvbnRleHQsIGVuZFRvcG9JZCwge1xuICAgICAgICB0eXBlOiBBU1RfQkxLX0lOVEVSRkFDRV9SRVRVUk5cbiAgICB9KTtcbiAgICBcbiAgICByZXR1cm4gZW5kVG9wb0lkO1xufVxuXG5mdW5jdGlvbiBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIG5hbWUpIHtcbiAgICBpZiAoY29tcGlsZUNvbnRleHQudG9wb05vZGVzLmhhcyhuYW1lKSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFRvcG8gaWQgXCIke25hbWV9XCIgYWxyZWFkeSBjcmVhdGVkLmApO1xuICAgIH1cblxuICAgIGFzc2VydDogIWNvbXBpbGVDb250ZXh0LnRvcG9Tb3J0Lmhhc0RlcGVuZGVuY3kobmFtZSksICdBbHJlYWR5IGluIHRvcG9Tb3J0ISc7XG5cbiAgICBjb21waWxlQ29udGV4dC50b3BvTm9kZXMuYWRkKG5hbWUpO1xuXG4gICAgaWYgKG5hbWUgPT09ICcnKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcigpO1xuICAgIH1cblxuICAgIHJldHVybiBuYW1lO1xufVxuXG5mdW5jdGlvbiBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIHByZXZpb3VzT3AsIGN1cnJlbnRPcCkge1xuICAgIHByZTogcHJldmlvdXNPcCAhPT0gY3VycmVudE9wLCAnU2VsZiBkZXBlbmRpbmcnO1xuXG4gICAgY29tcGlsZUNvbnRleHQubG9nZ2VyLmRlYnVnKGN1cnJlbnRPcCArICcgXFx4MWJbMzNtZGVwZW5kcyBvblxceDFiWzBtICcgKyBwcmV2aW91c09wKTtcblxuICAgIGlmICghY29tcGlsZUNvbnRleHQudG9wb05vZGVzLmhhcyhjdXJyZW50T3ApKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgVG9wbyBpZCBcIiR7Y3VycmVudE9wfVwiIG5vdCBjcmVhdGVkLmApO1xuICAgIH1cblxuICAgIGNvbXBpbGVDb250ZXh0LnRvcG9Tb3J0LmFkZChwcmV2aW91c09wLCBjdXJyZW50T3ApO1xufVxuXG5mdW5jdGlvbiBhZGRDb2RlQmxvY2soY29tcGlsZUNvbnRleHQsIHRvcG9JZCwgYmxvY2tNZXRhKSB7XG4gICAgaWYgKCEodG9wb0lkIGluIGNvbXBpbGVDb250ZXh0LmFzdE1hcCkpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBBU1Qgbm90IGZvdW5kIGZvciBibG9jayB3aXRoIHRvcG9JZDogJHt0b3BvSWR9YCk7XG4gICAgfVxuXG4gICAgY29tcGlsZUNvbnRleHQubWFwT2ZUb2tlblRvTWV0YS5zZXQodG9wb0lkLCBibG9ja01ldGEpO1xuXG4gICAgY29tcGlsZUNvbnRleHQubG9nZ2VyLnZlcmJvc2UoYEFkZGluZyAke2Jsb2NrTWV0YS50eXBlfSBcIiR7dG9wb0lkfVwiIGludG8gc291cmNlIGNvZGUuYCk7XG4gICAgLy9jb21waWxlQ29udGV4dC5sb2dnZXIuZGVidWcoJ0FTVDpcXG4nICsgSlNPTi5zdHJpbmdpZnkoY29tcGlsZUNvbnRleHQuYXN0TWFwW3RvcG9JZF0sIG51bGwsIDIpKTtcbn1cblxuZnVuY3Rpb24gZ2V0Q29kZVJlcHJlc2VudGF0aW9uT2YodG9wb0lkLCBjb21waWxlQ29udGV4dCkge1xuICAgIGxldCBsYXN0U291cmNlVHlwZSA9IGNvbXBpbGVDb250ZXh0Lm1hcE9mVG9rZW5Ub01ldGEuZ2V0KHRvcG9JZCk7XG5cbiAgICBpZiAobGFzdFNvdXJjZVR5cGUgJiYgKGxhc3RTb3VyY2VUeXBlLnR5cGUgPT09IEFTVF9CTEtfUFJPQ0VTU09SX0NBTEwgfHwgbGFzdFNvdXJjZVR5cGUudHlwZSA9PT0gQVNUX0JMS19BQ1RJVkFUT1JfQ0FMTCkpIHtcbiAgICAgICAgLy9mb3IgbW9kaWZpZXIsIGp1c3QgdXNlIHRoZSBmaW5hbCByZXN1bHRcbiAgICAgICAgcmV0dXJuIEpzTGFuZy5hc3RWYXJSZWYobGFzdFNvdXJjZVR5cGUudGFyZ2V0LCB0cnVlKTtcbiAgICB9XG5cbiAgICBsZXQgYXN0ID0gY29tcGlsZUNvbnRleHQuYXN0TWFwW3RvcG9JZF07XG4gICAgaWYgKGFzdC50eXBlID09PSAnTWVtYmVyRXhwcmVzc2lvbicgJiYgYXN0Lm9iamVjdC5uYW1lID09PSAnbGF0ZXN0Jykge1xuICAgICAgICByZXR1cm4gSnNMYW5nLmFzdENvbmRpdGlvbmFsKFxuICAgICAgICAgICAgSnNMYW5nLmFzdENhbGwoJ2xhdGVzdC5oYXNPd25Qcm9wZXJ0eScsIFsgYXN0LnByb3BlcnR5LnZhbHVlIF0pLCAvKiogdGVzdCAqL1xuICAgICAgICAgICAgYXN0LCAvKiogY29uc2VxdWVudCAqL1xuICAgICAgICAgICAgeyAuLi5hc3QsIG9iamVjdDogeyAuLi5hc3Qub2JqZWN0LCBuYW1lOiAnZXhpc3RpbmcnIH0gfVxuICAgICAgICApOyAgIFxuICAgIH1cblxuICAgIHJldHVybiBjb21waWxlQ29udGV4dC5hc3RNYXBbdG9wb0lkXTtcbn1cblxuZnVuY3Rpb24gY3JlYXRlQ29tcGlsZUNvbnRleHQodGFyZ2V0TmFtZSwgbG9nZ2VyLCBzaGFyZWRDb250ZXh0KSB7XG4gICAgbGV0IGNvbXBpbGVDb250ZXh0ID0ge1xuICAgICAgICB0YXJnZXROYW1lLCAgICAgICAgXG4gICAgICAgIGxvZ2dlcixcbiAgICAgICAgdG9wb05vZGVzOiBuZXcgU2V0KCksXG4gICAgICAgIHRvcG9Tb3J0OiBuZXcgVG9wb1NvcnQoKSxcbiAgICAgICAgYXN0TWFwOiB7fSwgLy8gU3RvcmUgdGhlIEFTVCBmb3IgYSBub2RlXG4gICAgICAgIG1hcE9mVG9rZW5Ub01ldGE6IG5ldyBNYXAoKSwgLy8gU3RvcmUgdGhlIHNvdXJjZSBjb2RlIGJsb2NrIHBvaW50XG4gICAgICAgIG1vZGVsVmFyczogbmV3IFNldCgpLFxuICAgICAgICBtYXBPZkZ1bmN0b3JUb0ZpbGU6IChzaGFyZWRDb250ZXh0ICYmIHNoYXJlZENvbnRleHQubWFwT2ZGdW5jdG9yVG9GaWxlKSB8fCB7fSwgLy8gVXNlIHRvIHJlY29yZCBpbXBvcnQgbGluZXNcbiAgICAgICAgbmV3RnVuY3RvckZpbGVzOiAoc2hhcmVkQ29udGV4dCAmJiBzaGFyZWRDb250ZXh0Lm5ld0Z1bmN0b3JGaWxlcykgfHwgW11cbiAgICB9O1xuXG4gICAgY29tcGlsZUNvbnRleHQubWFpblN0YXJ0SWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsICckbWFpbicpO1xuXG4gICAgbG9nZ2VyLnZlcmJvc2UoYENyZWF0ZWQgY29tcGlsYXRpb24gY29udGV4dCBmb3IgXCIke3RhcmdldE5hbWV9XCIuYCk7XG5cbiAgICByZXR1cm4gY29tcGlsZUNvbnRleHQ7XG59XG5cbmZ1bmN0aW9uIGlzVG9wTGV2ZWxCbG9jayh0b3BvSWQpIHtcbiAgICByZXR1cm4gdG9wb0lkLmluZGV4T2YoJzphcmdbJykgPT09IC0xICYmIHRvcG9JZC5pbmRleE9mKCckY2FzZXNbJykgPT09IC0xICYmIHRvcG9JZC5pbmRleE9mKCckZXhjZXB0aW9uc1snKSA9PT0gLTE7XG59XG5cbmZ1bmN0aW9uIHJlcGxhY2VWYXJSZWZTY29wZSh2YXJSZWYsIHRhcmdldFNjb3BlKSB7XG4gICAgaWYgKF8uaXNQbGFpbk9iamVjdCh2YXJSZWYpKSB7XG4gICAgICAgIGFzc2VydDogdmFyUmVmLm9vbFR5cGUgPT09ICdPYmplY3RSZWZlcmVuY2UnO1xuXG4gICAgICAgIHJldHVybiB7IG9vbFR5cGU6ICdPYmplY3RSZWZlcmVuY2UnLCBuYW1lOiByZXBsYWNlVmFyUmVmU2NvcGUodmFyUmVmLm5hbWUsIHRhcmdldFNjb3BlKSB9OyAgICAgICAgXG4gICAgfSBcblxuICAgIGFzc2VydDogdHlwZW9mIHZhclJlZiA9PT0gJ3N0cmluZyc7XG5cbiAgICBsZXQgcGFydHMgPSB2YXJSZWYuc3BsaXQoJy4nKTtcbiAgICBhc3NlcnQ6IHBhcnRzLmxlbmd0aCA+IDE7XG5cbiAgICBwYXJ0cy5zcGxpY2UoMCwgMSwgdGFyZ2V0U2NvcGUpO1xuICAgIHJldHVybiBwYXJ0cy5qb2luKCcuJyk7XG59XG5cbm1vZHVsZS5leHBvcnRzID0ge1xuICAgIGNvbXBpbGVQYXJhbSxcbiAgICBjb21waWxlRmllbGQsXG4gICAgY29tcGlsZURiT3BlcmF0aW9uLFxuICAgIGNvbXBpbGVFeGNlcHRpb25hbFJldHVybixcbiAgICBjb21waWxlUmV0dXJuLFxuICAgIGNyZWF0ZVRvcG9JZCxcbiAgICBjcmVhdGVDb21waWxlQ29udGV4dCxcbiAgICBkZXBlbmRzT24sXG4gICAgYWRkQ29kZUJsb2NrLFxuXG4gICAgQVNUX0JMS19GSUVMRF9QUkVfUFJPQ0VTUyxcbiAgICBBU1RfQkxLX1BST0NFU1NPUl9DQUxMLFxuICAgIEFTVF9CTEtfVkFMSURBVE9SX0NBTEwsXG4gICAgQVNUX0JMS19BQ1RJVkFUT1JfQ0FMTCxcbiAgICBBU1RfQkxLX1ZJRVdfT1BFUkFUSU9OLFxuICAgIEFTVF9CTEtfVklFV19SRVRVUk4sXG4gICAgQVNUX0JMS19JTlRFUkZBQ0VfT1BFUkFUSU9OLFxuICAgIEFTVF9CTEtfSU5URVJGQUNFX1JFVFVSTiwgXG4gICAgQVNUX0JMS19FWENFUFRJT05fSVRFTSxcblxuICAgIE9PTF9NT0RJRklFUl9DT0RFX0ZMQUdcbn07Il19