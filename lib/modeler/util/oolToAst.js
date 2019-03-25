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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9tb2RlbGVyL3V0aWwvb29sVG9Bc3QuanMiXSwibmFtZXMiOlsiXyIsInJlcXVpcmUiLCJUb3BvU29ydCIsIkpzTGFuZyIsIk9vbFR5cGVzIiwiaXNEb3RTZXBhcmF0ZU5hbWUiLCJleHRyYWN0RG90U2VwYXJhdGVOYW1lIiwiZXh0cmFjdFJlZmVyZW5jZUJhc2VOYW1lIiwiT29sb25nVmFsaWRhdG9ycyIsIk9vbG9uZ1Byb2Nlc3NvcnMiLCJPb2xvbmdBY3RpdmF0b3JzIiwiVHlwZXMiLCJkZWZhdWx0RXJyb3IiLCJBU1RfQkxLX0ZJRUxEX1BSRV9QUk9DRVNTIiwiQVNUX0JMS19QQVJBTV9TQU5JVElaRSIsIkFTVF9CTEtfUFJPQ0VTU09SX0NBTEwiLCJBU1RfQkxLX1ZBTElEQVRPUl9DQUxMIiwiQVNUX0JMS19BQ1RJVkFUT1JfQ0FMTCIsIkFTVF9CTEtfVklFV19PUEVSQVRJT04iLCJBU1RfQkxLX1ZJRVdfUkVUVVJOIiwiQVNUX0JMS19JTlRFUkZBQ0VfT1BFUkFUSU9OIiwiQVNUX0JMS19JTlRFUkZBQ0VfUkVUVVJOIiwiQVNUX0JMS19FWENFUFRJT05fSVRFTSIsIk9PTF9NT0RJRklFUl9DT0RFX0ZMQUciLCJNb2RpZmllciIsIlZBTElEQVRPUiIsIlBST0NFU1NPUiIsIkFDVElWQVRPUiIsIk9PTF9NT0RJRklFUl9PUCIsIk9PTF9NT0RJRklFUl9QQVRIIiwiT09MX01PRElGSUVSX0JVSUxUSU4iLCJPUEVSQVRPUl9UT0tFTiIsImNvbXBpbGVDb25kaXRpb25hbEV4cHJlc3Npb24iLCJ0ZXN0IiwiY29tcGlsZUNvbnRleHQiLCJzdGFydFRvcG9JZCIsImlzUGxhaW5PYmplY3QiLCJvb2xUeXBlIiwiZW5kVG9wb0lkIiwiY3JlYXRlVG9wb0lkIiwib3BlcmFuZFRvcG9JZCIsImRlcGVuZHNPbiIsImxhc3RPcGVyYW5kVG9wb0lkIiwiY29tcGlsZUNvbmNyZXRlVmFsdWVFeHByZXNzaW9uIiwiY2FsbGVyIiwiYXN0QXJndW1lbnQiLCJnZXRDb2RlUmVwcmVzZW50YXRpb25PZiIsInJldFRvcG9JZCIsImNvbXBpbGVBZEhvY1ZhbGlkYXRvciIsImNhbGxlZSIsIm9wIiwib3BlcmF0b3IiLCJFcnJvciIsImxlZnRUb3BvSWQiLCJyaWdodFRvcG9JZCIsImxhc3RMZWZ0SWQiLCJsZWZ0IiwibGFzdFJpZ2h0SWQiLCJyaWdodCIsImFzdE1hcCIsImFzdEJpbkV4cCIsImFyZ3VtZW50IiwiYXN0Tm90IiwiYXN0Q2FsbCIsInZhbHVlU3RhcnRUb3BvSWQiLCJhc3RWYWx1ZSIsInRvcG9JZCIsInZhbHVlIiwiZnVuY3RvciIsImNhbGxBcmdzIiwiYXJncyIsInRyYW5zbGF0ZUFyZ3MiLCJhcmcwIiwibmFtZSIsImNvbmNhdCIsImNvbXBpbGVNb2RpZmllciIsImRlY2xhcmVQYXJhbXMiLCJ0cmFuc2xhdGVGdW5jdGlvblBhcmFtcyIsImlzRW1wdHkiLCJmdW5jdG9ySWQiLCJ0cmFuc2xhdGVNb2RpZmllciIsInJlZmVyZW5jZXMiLCJleHRyYWN0UmVmZXJlbmNlZEZpZWxkcyIsImZpbmQiLCJyZWYiLCJpc1RvcExldmVsQmxvY2siLCJzdGFydHNXaXRoIiwiYXN0Q29uZGl0aW9uYWwiLCJyZXBsYWNlVmFyUmVmU2NvcGUiLCJ0YXJnZXRWYXJOYW1lIiwibmVlZERlY2xhcmUiLCJ2YXJpYWJsZXMiLCJjb3VudGVyIiwidG9TdHJpbmciLCJoYXNPd25Qcm9wZXJ0eSIsInR5cGUiLCJzb3VyY2UiLCJhZGRDb2RlQmxvY2siLCJ0YXJnZXQiLCJvb2xBcmdzIiwiY2FzdEFycmF5IiwicmVmcyIsImZvckVhY2giLCJhIiwicmVzdWx0IiwiY2hlY2tSZWZlcmVuY2VUb0ZpZWxkIiwicHVzaCIsIm9iaiIsInVuZGVmaW5lZCIsImFkZE1vZGlmaWVyVG9NYXAiLCJmdW5jdG9yVHlwZSIsImZ1bmN0b3JKc0ZpbGUiLCJtYXBPZkZ1bmN0b3JUb0ZpbGUiLCJmdW5jdGlvbk5hbWUiLCJmaWxlTmFtZSIsIm5hbWVzIiwibGVuZ3RoIiwicmVmRW50aXR5TmFtZSIsInVwcGVyRmlyc3QiLCJidWlsdGlucyIsIm1vZHVsZU5hbWUiLCJuZXdGdW5jdG9yRmlsZXMiLCJjb21waWxlUGlwZWRWYWx1ZSIsInZhck9vbCIsImxhc3RUb3BvSWQiLCJtb2RpZmllcnMiLCJtb2RpZmllciIsIm1vZGlmaWVyU3RhcnRUb3BvSWQiLCJjb21waWxlVmFyaWFibGVSZWZlcmVuY2UiLCJTZXQiLCJ0cmFuc2xhdGVGdW5jdGlvblBhcmFtIiwiYXJnIiwiaSIsInBvcCIsIm1hcCIsImJhc2VOYW1lIiwiY291bnQiLCJoYXMiLCJhZGQiLCJyZWZCYXNlIiwicmVzdCIsImRlcGVuZGVuY3kiLCJvbmdvaW5nIiwicmVmRmllbGROYW1lIiwibWFwVmFsdWVzIiwidmFsdWVPZkVsZW1lbnQiLCJrZXkiLCJzaWQiLCJlaWQiLCJBcnJheSIsImlzQXJyYXkiLCJpbmRleCIsImVhY2giLCJhcmdUb3BvSWQiLCJjb21waWxlUGFyYW0iLCJwYXJhbSIsInR5cGVPYmplY3QiLCJzYW5pdGl6ZXJOYW1lIiwidG9VcHBlckNhc2UiLCJ2YXJSZWYiLCJhc3RWYXJSZWYiLCJjYWxsQXN0IiwiYXN0QXJyYXlBY2Nlc3MiLCJwcmVwYXJlVG9wb0lkIiwiYXN0QXNzaWduIiwibWFpblN0YXJ0SWQiLCJ3cmFwUGFyYW1SZWZlcmVuY2UiLCJyZWFkeVRvcG9JZCIsImNvbXBpbGVGaWVsZCIsInBhcmFtTmFtZSIsImNvbnRleHROYW1lIiwiT2JqZWN0IiwiYXNzaWduIiwiaGFzTW9kZWxGaWVsZCIsIm9wZXJhbmQiLCJiYXNlVmFyIiwic3BsaXQiLCJ0cmFuc2xhdGVSZXR1cm5UaGVuQXN0Iiwic3RhcnRJZCIsImVuZElkIiwidGhlbiIsImFzdFRocm93IiwiZXJyb3JUeXBlIiwibWVzc2FnZSIsInRyYW5zbGF0ZVJldHVyblZhbHVlQXN0IiwidmFsdWVFbmRJZCIsImFzdFJldHVybiIsInRyYW5zbGF0ZVRoZW5Bc3QiLCJhc3NpZ25UbyIsImNvbmRpdGlvbiIsInN0YXJ0UmlnaHRJZCIsInZhbHVlVG9wb0lkIiwiY29tcGlsZVJldHVybiIsImNvbXBpbGVGaW5kT25lIiwib3BlcmF0aW9uIiwiY29uZGl0aW9uVmFyTmFtZSIsImFzdCIsImFzdFZhckRlY2xhcmUiLCJtb2RlbCIsInRvcG9JZFByZWZpeCIsImxhc3RTdGF0ZW1lbnQiLCJlbHNlIiwiZWxzZVN0YXJ0IiwiZWxzZUVuZCIsIml0ZW1zIiwicmV2ZXJzZSIsIml0ZW0iLCJjYXNlUHJlZml4IiwiY2FzZVRvcG9JZCIsImNhc2VSZXN1bHRWYXJOYW1lIiwiYXN0Q2FzZVR0ZW0iLCJpZlN0YXJ0IiwiaWZFbmQiLCJhc3RJZiIsImFzdEJsb2NrIiwiYXN0QXdhaXQiLCJtb2RlbFRvcG9JZCIsImNvbXBpbGVEYk9wZXJhdGlvbiIsImRvQmxvY2siLCJkbyIsImNvbXBpbGVEb1N0YXRlbWVudCIsImNvbXBpbGVFeGNlcHRpb25hbFJldHVybiIsIm9vbE5vZGUiLCJsYXN0RXhjZXB0aW9uSWQiLCJleGNlcHRpb25zIiwiZXhjZXB0aW9uU3RhcnRJZCIsImV4Y2VwdGlvbkVuZElkIiwidGhlblN0YXJ0SWQiLCJyZXR1cm5TdGFydFRvcG9JZCIsInRvcG9Ob2RlcyIsInRvcG9Tb3J0IiwiaGFzRGVwZW5kZW5jeSIsInByZXZpb3VzT3AiLCJjdXJyZW50T3AiLCJsb2dnZXIiLCJkZWJ1ZyIsImJsb2NrTWV0YSIsIm1hcE9mVG9rZW5Ub01ldGEiLCJzZXQiLCJ2ZXJib3NlIiwibGFzdFNvdXJjZVR5cGUiLCJnZXQiLCJvYmplY3QiLCJwcm9wZXJ0eSIsImNyZWF0ZUNvbXBpbGVDb250ZXh0Iiwic2hhcmVkQ29udGV4dCIsIk1hcCIsIm1vZGVsVmFycyIsImluZGV4T2YiLCJ0YXJnZXRTY29wZSIsInBhcnRzIiwic3BsaWNlIiwiam9pbiIsIm1vZHVsZSIsImV4cG9ydHMiXSwibWFwcGluZ3MiOiJBQUFBOzs7O0FBT0EsTUFBTTtBQUFFQSxFQUFBQTtBQUFGLElBQVFDLE9BQU8sQ0FBQyxVQUFELENBQXJCOztBQUNBLE1BQU07QUFBRUMsRUFBQUE7QUFBRixJ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O0FBQ0g7O0FBTDRDLFFBT3JDLE9BQU8xRixNQUFQLEtBQWtCLFFBUG1CO0FBQUE7QUFBQTs7QUFTN0MsTUFBSTJGLEtBQUssR0FBRzNGLE1BQU0sQ0FBQ2lCLEtBQVAsQ0FBYSxHQUFiLENBQVo7O0FBVDZDLFFBVXJDMEUsS0FBSyxDQUFDdEksTUFBTixHQUFlLENBVnNCO0FBQUE7QUFBQTs7QUFZN0NzSSxFQUFBQSxLQUFLLENBQUNDLE1BQU4sQ0FBYSxDQUFiLEVBQWdCLENBQWhCLEVBQW1CRixXQUFuQjtBQUNBLFNBQU9DLEtBQUssQ0FBQ0UsSUFBTixDQUFXLEdBQVgsQ0FBUDtBQUNIOztBQUVEQyxNQUFNLENBQUNDLE9BQVAsR0FBaUI7QUFDYnBHLEVBQUFBLFlBRGE7QUFFYmMsRUFBQUEsWUFGYTtBQUdiaUQsRUFBQUEsa0JBSGE7QUFJYkksRUFBQUEsd0JBSmE7QUFLYjdCLEVBQUFBLGFBTGE7QUFNYnpKLEVBQUFBLFlBTmE7QUFPYjZNLEVBQUFBLG9CQVBhO0FBUWIzTSxFQUFBQSxTQVJhO0FBU2J3RCxFQUFBQSxZQVRhO0FBV2JwRixFQUFBQSx5QkFYYTtBQVliRSxFQUFBQSxzQkFaYTtBQWFiQyxFQUFBQSxzQkFiYTtBQWNiQyxFQUFBQSxzQkFkYTtBQWViQyxFQUFBQSxzQkFmYTtBQWdCYkMsRUFBQUEsbUJBaEJhO0FBaUJiQyxFQUFBQSwyQkFqQmE7QUFrQmJDLEVBQUFBLHdCQWxCYTtBQW1CYkMsRUFBQUEsc0JBbkJhO0FBcUJiQyxFQUFBQTtBQXJCYSxDQUFqQiIsInNvdXJjZXNDb250ZW50IjpbIlwidXNlIHN0cmljdFwiO1xuXG4vKipcbiAqIEBtb2R1bGVcbiAqIEBpZ25vcmVcbiAqL1xuXG5jb25zdCB7IF8gfSA9IHJlcXVpcmUoJ3JrLXV0aWxzJyk7XG5jb25zdCB7IFRvcG9Tb3J0IH0gPSByZXF1aXJlKCdAay1zdWl0ZS9hbGdvcml0aG1zJyk7XG5cbmNvbnN0IEpzTGFuZyA9IHJlcXVpcmUoJy4vYXN0LmpzJyk7XG5jb25zdCBPb2xUeXBlcyA9IHJlcXVpcmUoJy4uLy4uL2xhbmcvT29sVHlwZXMnKTtcbmNvbnN0IHsgaXNEb3RTZXBhcmF0ZU5hbWUsIGV4dHJhY3REb3RTZXBhcmF0ZU5hbWUsIGV4dHJhY3RSZWZlcmVuY2VCYXNlTmFtZSB9ID0gcmVxdWlyZSgnLi4vLi4vbGFuZy9Pb2xVdGlscycpO1xuY29uc3QgT29sb25nVmFsaWRhdG9ycyA9IHJlcXVpcmUoJy4uLy4uL3J1bnRpbWUvVmFsaWRhdG9ycycpO1xuY29uc3QgT29sb25nUHJvY2Vzc29ycyA9IHJlcXVpcmUoJy4uLy4uL3J1bnRpbWUvUHJvY2Vzc29ycycpO1xuY29uc3QgT29sb25nQWN0aXZhdG9ycyA9IHJlcXVpcmUoJy4uLy4uL3J1bnRpbWUvQWN0aXZhdG9ycycpO1xuY29uc3QgVHlwZXMgPSByZXF1aXJlKCcuLi8uLi9ydW50aW1lL3R5cGVzJyk7XG5cbmNvbnN0IGRlZmF1bHRFcnJvciA9ICdJbnZhbGlkUmVxdWVzdCc7XG5cbmNvbnN0IEFTVF9CTEtfRklFTERfUFJFX1BST0NFU1MgPSAnRmllbGRQcmVQcm9jZXNzJztcbmNvbnN0IEFTVF9CTEtfUEFSQU1fU0FOSVRJWkUgPSAnUGFyYW1ldGVyU2FuaXRpemUnO1xuY29uc3QgQVNUX0JMS19QUk9DRVNTT1JfQ0FMTCA9ICdQcm9jZXNzb3JDYWxsJztcbmNvbnN0IEFTVF9CTEtfVkFMSURBVE9SX0NBTEwgPSAnVmFsaWRhdG9yQ2FsbCc7XG5jb25zdCBBU1RfQkxLX0FDVElWQVRPUl9DQUxMID0gJ0FjdGl2YXRvckNhbGwnO1xuY29uc3QgQVNUX0JMS19WSUVXX09QRVJBVElPTiA9ICdWaWV3T3BlcmF0aW9uJztcbmNvbnN0IEFTVF9CTEtfVklFV19SRVRVUk4gPSAnVmlld1JldHVybic7XG5jb25zdCBBU1RfQkxLX0lOVEVSRkFDRV9PUEVSQVRJT04gPSAnSW50ZXJmYWNlT3BlcmF0aW9uJztcbmNvbnN0IEFTVF9CTEtfSU5URVJGQUNFX1JFVFVSTiA9ICdJbnRlcmZhY2VSZXR1cm4nO1xuY29uc3QgQVNUX0JMS19FWENFUFRJT05fSVRFTSA9ICdFeGNlcHRpb25JdGVtJztcblxuY29uc3QgT09MX01PRElGSUVSX0NPREVfRkxBRyA9IHtcbiAgICBbT29sVHlwZXMuTW9kaWZpZXIuVkFMSURBVE9SXTogQVNUX0JMS19WQUxJREFUT1JfQ0FMTCxcbiAgICBbT29sVHlwZXMuTW9kaWZpZXIuUFJPQ0VTU09SXTogQVNUX0JMS19QUk9DRVNTT1JfQ0FMTCxcbiAgICBbT29sVHlwZXMuTW9kaWZpZXIuQUNUSVZBVE9SXTogQVNUX0JMS19BQ1RJVkFUT1JfQ0FMTFxufTtcblxuY29uc3QgT09MX01PRElGSUVSX09QID0ge1xuICAgIFtPb2xUeXBlcy5Nb2RpZmllci5WQUxJREFUT1JdOiAnficsXG4gICAgW09vbFR5cGVzLk1vZGlmaWVyLlBST0NFU1NPUl06ICd8PicsXG4gICAgW09vbFR5cGVzLk1vZGlmaWVyLkFDVElWQVRPUl06ICc9JyBcbn07XG5cbmNvbnN0IE9PTF9NT0RJRklFUl9QQVRIID0ge1xuICAgIFtPb2xUeXBlcy5Nb2RpZmllci5WQUxJREFUT1JdOiAndmFsaWRhdG9ycycsXG4gICAgW09vbFR5cGVzLk1vZGlmaWVyLlBST0NFU1NPUl06ICdwcm9jZXNzb3JzJyxcbiAgICBbT29sVHlwZXMuTW9kaWZpZXIuQUNUSVZBVE9SXTogJ2FjdGl2YXRvcnMnIFxufTtcblxuY29uc3QgT09MX01PRElGSUVSX0JVSUxUSU4gPSB7XG4gICAgW09vbFR5cGVzLk1vZGlmaWVyLlZBTElEQVRPUl06IE9vbG9uZ1ZhbGlkYXRvcnMsXG4gICAgW09vbFR5cGVzLk1vZGlmaWVyLlBST0NFU1NPUl06IE9vbG9uZ1Byb2Nlc3NvcnMsXG4gICAgW09vbFR5cGVzLk1vZGlmaWVyLkFDVElWQVRPUl06IE9vbG9uZ0FjdGl2YXRvcnMgXG59O1xuXG5jb25zdCBPUEVSQVRPUl9UT0tFTiA9IHtcbiAgICBcIj5cIjogXCIkZ3RcIixcbiAgICBcIjxcIjogXCIkbHRcIixcbiAgICBcIj49XCI6IFwiJGd0ZVwiLFxuICAgIFwiPD1cIjogXCIkbHRlXCIsXG4gICAgXCI9PVwiOiBcIiRlcVwiLFxuICAgIFwiIT1cIjogXCIkbmVcIixcbiAgICBcImluXCI6IFwiJGluXCIsXG4gICAgXCJub3RJblwiOiBcIiRuaW5cIlxufTtcblxuLyoqXG4gKiBDb21waWxlIGEgY29uZGl0aW9uYWwgZXhwcmVzc2lvblxuICogQHBhcmFtIHtvYmplY3R9IHRlc3RcbiAqIEBwYXJhbSB7b2JqZWN0fSBjb21waWxlQ29udGV4dFxuICogQHByb3BlcnR5IHtzdHJpbmd9IGNvbXBpbGVDb250ZXh0Lm1vZHVsZU5hbWVcbiAqIEBwcm9wZXJ0eSB7VG9wb1NvcnR9IGNvbXBpbGVDb250ZXh0LnRvcG9Tb3J0XG4gKiBAcHJvcGVydHkge29iamVjdH0gY29tcGlsZUNvbnRleHQuYXN0TWFwIC0gVG9wbyBJZCB0byBhc3QgbWFwXG4gKiBAcGFyYW0ge3N0cmluZ30gc3RhcnRUb3BvSWRcbiAqIEByZXR1cm5zIHtzdHJpbmd9IFRvcG8gSWRcbiAqL1xuZnVuY3Rpb24gY29tcGlsZUNvbmRpdGlvbmFsRXhwcmVzc2lvbih0ZXN0LCBjb21waWxlQ29udGV4dCwgc3RhcnRUb3BvSWQpIHtcbiAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHRlc3QpKSB7ICAgICAgICBcbiAgICAgICAgaWYgKHRlc3Qub29sVHlwZSA9PT0gJ1ZhbGlkYXRlRXhwcmVzc2lvbicpIHtcbiAgICAgICAgICAgIGxldCBlbmRUb3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkICsgJyR2YWxpT3A6ZG9uZScpO1xuICAgICAgICAgICAgbGV0IG9wZXJhbmRUb3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkICsgJyR2YWxpT3AnKTtcblxuICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCwgb3BlcmFuZFRvcG9JZCk7XG5cbiAgICAgICAgICAgIGxldCBsYXN0T3BlcmFuZFRvcG9JZCA9IGNvbXBpbGVDb25jcmV0ZVZhbHVlRXhwcmVzc2lvbihvcGVyYW5kVG9wb0lkLCB0ZXN0LmNhbGxlciwgY29tcGlsZUNvbnRleHQpO1xuICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBsYXN0T3BlcmFuZFRvcG9JZCwgZW5kVG9wb0lkKTtcblxuICAgICAgICAgICAgbGV0IGFzdEFyZ3VtZW50ID0gZ2V0Q29kZVJlcHJlc2VudGF0aW9uT2YobGFzdE9wZXJhbmRUb3BvSWQsIGNvbXBpbGVDb250ZXh0KTtcblxuICAgICAgICAgICAgbGV0IHJldFRvcG9JZCA9IGNvbXBpbGVBZEhvY1ZhbGlkYXRvcihlbmRUb3BvSWQsIGFzdEFyZ3VtZW50LCB0ZXN0LmNhbGxlZSwgY29tcGlsZUNvbnRleHQpO1xuXG4gICAgICAgICAgICBhc3NlcnQ6IHJldFRvcG9JZCA9PT0gZW5kVG9wb0lkO1xuXG4gICAgICAgICAgICAvKlxuICAgICAgICAgICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW2VuZFRvcG9JZF0gPSBKc0xhbmcuYXN0Q2FsbCgnXy5pc0VtcHR5JywgYXN0QXJndW1lbnQpO1xuXG4gICAgICAgICAgICBzd2l0Y2ggKHRlc3Qub3BlcmF0b3IpIHtcbiAgICAgICAgICAgICAgICBjYXNlICdleGlzdHMnOlxuICAgICAgICAgICAgICAgICAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbZW5kVG9wb0lkXSA9IEpzTGFuZy5hc3ROb3QoSnNMYW5nLmFzdENhbGwoJ18uaXNFbXB0eScsIGFzdEFyZ3VtZW50KSk7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgY2FzZSAnaXMtbm90LW51bGwnOlxuICAgICAgICAgICAgICAgICAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbZW5kVG9wb0lkXSA9IEpzTGFuZy5hc3ROb3QoSnNMYW5nLmFzdENhbGwoJ18uaXNOaWwnLCBhc3RBcmd1bWVudCkpO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgICAgIGNhc2UgJ25vdC1leGlzdHMnOlxuICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgICAgICBjYXNlICdpcy1udWxsJzpcbiAgICAgICAgICAgICAgICAgICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW2VuZFRvcG9JZF0gPSBKc0xhbmcuYXN0Q2FsbCgnXy5pc05pbCcsIGFzdEFyZ3VtZW50KTtcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgICAgICBjYXNlICdub3QnOlxuICAgICAgICAgICAgICAgICAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbZW5kVG9wb0lkXSA9IEpzTGFuZy5hc3ROb3QoYXN0QXJndW1lbnQpO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5zdXBwb3J0ZWQgdGVzdCBvcGVyYXRvcjogJyArIHRlc3Qub3BlcmF0b3IpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgKi9cblxuICAgICAgICAgICAgcmV0dXJuIGVuZFRvcG9JZDtcblxuICAgICAgICB9IGVsc2UgaWYgKHRlc3Qub29sVHlwZSA9PT0gJ0xvZ2ljYWxFeHByZXNzaW9uJykge1xuICAgICAgICAgICAgbGV0IGVuZFRvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgc3RhcnRUb3BvSWQgKyAnJGxvcE9wOmRvbmUnKTtcblxuICAgICAgICAgICAgbGV0IG9wO1xuXG4gICAgICAgICAgICBzd2l0Y2ggKHRlc3Qub3BlcmF0b3IpIHtcbiAgICAgICAgICAgICAgICBjYXNlICdhbmQnOlxuICAgICAgICAgICAgICAgICAgICBvcCA9ICcmJic7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgY2FzZSAnb3InOlxuICAgICAgICAgICAgICAgICAgICBvcCA9ICd8fCc7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbnN1cHBvcnRlZCB0ZXN0IG9wZXJhdG9yOiAnICsgdGVzdC5vcGVyYXRvcik7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCBsZWZ0VG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCArICckbG9wT3A6bGVmdCcpO1xuICAgICAgICAgICAgbGV0IHJpZ2h0VG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCArICckbG9wT3A6cmlnaHQnKTtcblxuICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCwgbGVmdFRvcG9JZCk7XG4gICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkLCByaWdodFRvcG9JZCk7XG5cbiAgICAgICAgICAgIGxldCBsYXN0TGVmdElkID0gY29tcGlsZUNvbmRpdGlvbmFsRXhwcmVzc2lvbih0ZXN0LmxlZnQsIGNvbXBpbGVDb250ZXh0LCBsZWZ0VG9wb0lkKTtcbiAgICAgICAgICAgIGxldCBsYXN0UmlnaHRJZCA9IGNvbXBpbGVDb25kaXRpb25hbEV4cHJlc3Npb24odGVzdC5yaWdodCwgY29tcGlsZUNvbnRleHQsIHJpZ2h0VG9wb0lkKTtcblxuICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBsYXN0TGVmdElkLCBlbmRUb3BvSWQpO1xuICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBsYXN0UmlnaHRJZCwgZW5kVG9wb0lkKTtcblxuICAgICAgICAgICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW2VuZFRvcG9JZF0gPSBKc0xhbmcuYXN0QmluRXhwKFxuICAgICAgICAgICAgICAgIGdldENvZGVSZXByZXNlbnRhdGlvbk9mKGxhc3RMZWZ0SWQsIGNvbXBpbGVDb250ZXh0KSxcbiAgICAgICAgICAgICAgICBvcCxcbiAgICAgICAgICAgICAgICBnZXRDb2RlUmVwcmVzZW50YXRpb25PZihsYXN0UmlnaHRJZCwgY29tcGlsZUNvbnRleHQpXG4gICAgICAgICAgICApOyBcblxuICAgICAgICAgICAgcmV0dXJuIGVuZFRvcG9JZDtcblxuICAgICAgICB9IGVsc2UgaWYgKHRlc3Qub29sVHlwZSA9PT0gJ0JpbmFyeUV4cHJlc3Npb24nKSB7XG4gICAgICAgICAgICBsZXQgZW5kVG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCArICckYmluT3A6ZG9uZScpO1xuXG4gICAgICAgICAgICBsZXQgb3A7XG5cbiAgICAgICAgICAgIHN3aXRjaCAodGVzdC5vcGVyYXRvcikge1xuICAgICAgICAgICAgICAgIGNhc2UgJz4nOlxuICAgICAgICAgICAgICAgIGNhc2UgJzwnOlxuICAgICAgICAgICAgICAgIGNhc2UgJz49JzpcbiAgICAgICAgICAgICAgICBjYXNlICc8PSc6XG4gICAgICAgICAgICAgICAgY2FzZSAnaW4nOlxuICAgICAgICAgICAgICAgICAgICBvcCA9IHRlc3Qub3BlcmF0b3I7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgY2FzZSAnPT0nOlxuICAgICAgICAgICAgICAgICAgICBvcCA9ICc9PT0nO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgICAgIGNhc2UgJyE9JzpcbiAgICAgICAgICAgICAgICAgICAgb3AgPSAnIT09JztcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1Vuc3VwcG9ydGVkIHRlc3Qgb3BlcmF0b3I6ICcgKyB0ZXN0Lm9wZXJhdG9yKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IGxlZnRUb3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkICsgJyRiaW5PcDpsZWZ0Jyk7XG4gICAgICAgICAgICBsZXQgcmlnaHRUb3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkICsgJyRiaW5PcDpyaWdodCcpO1xuXG4gICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkLCBsZWZ0VG9wb0lkKTtcbiAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgc3RhcnRUb3BvSWQsIHJpZ2h0VG9wb0lkKTtcblxuICAgICAgICAgICAgbGV0IGxhc3RMZWZ0SWQgPSBjb21waWxlQ29uY3JldGVWYWx1ZUV4cHJlc3Npb24obGVmdFRvcG9JZCwgdGVzdC5sZWZ0LCBjb21waWxlQ29udGV4dCk7XG4gICAgICAgICAgICBsZXQgbGFzdFJpZ2h0SWQgPSBjb21waWxlQ29uY3JldGVWYWx1ZUV4cHJlc3Npb24ocmlnaHRUb3BvSWQsIHRlc3QucmlnaHQsIGNvbXBpbGVDb250ZXh0KTtcblxuICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBsYXN0TGVmdElkLCBlbmRUb3BvSWQpO1xuICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBsYXN0UmlnaHRJZCwgZW5kVG9wb0lkKTtcblxuICAgICAgICAgICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW2VuZFRvcG9JZF0gPSBKc0xhbmcuYXN0QmluRXhwKFxuICAgICAgICAgICAgICAgIGdldENvZGVSZXByZXNlbnRhdGlvbk9mKGxhc3RMZWZ0SWQsIGNvbXBpbGVDb250ZXh0KSxcbiAgICAgICAgICAgICAgICBvcCxcbiAgICAgICAgICAgICAgICBnZXRDb2RlUmVwcmVzZW50YXRpb25PZihsYXN0UmlnaHRJZCwgY29tcGlsZUNvbnRleHQpXG4gICAgICAgICAgICApOyBcblxuICAgICAgICAgICAgcmV0dXJuIGVuZFRvcG9JZDtcblxuICAgICAgICB9IGVsc2UgaWYgKHRlc3Qub29sVHlwZSA9PT0gJ1VuYXJ5RXhwcmVzc2lvbicpIHtcbiAgICAgICAgICAgIGxldCBlbmRUb3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkICsgJyR1bmFPcDpkb25lJyk7XG4gICAgICAgICAgICBsZXQgb3BlcmFuZFRvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgc3RhcnRUb3BvSWQgKyAnJHVuYU9wJyk7XG5cbiAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgc3RhcnRUb3BvSWQsIG9wZXJhbmRUb3BvSWQpO1xuXG4gICAgICAgICAgICBsZXQgbGFzdE9wZXJhbmRUb3BvSWQgPSB0ZXN0Lm9wZXJhdG9yID09PSAnbm90JyA/IGNvbXBpbGVDb25jcmV0ZVZhbHVlRXhwcmVzc2lvbihvcGVyYW5kVG9wb0lkLCB0ZXN0LmFyZ3VtZW50LCBjb21waWxlQ29udGV4dCkgOiBjb21waWxlQ29uZGl0aW9uYWxFeHByZXNzaW9uKHRlc3QuYXJndW1lbnQsIGNvbXBpbGVDb250ZXh0LCBvcGVyYW5kVG9wb0lkKTtcbiAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgbGFzdE9wZXJhbmRUb3BvSWQsIGVuZFRvcG9JZCk7XG5cbiAgICAgICAgICAgIGxldCBhc3RBcmd1bWVudCA9IGdldENvZGVSZXByZXNlbnRhdGlvbk9mKGxhc3RPcGVyYW5kVG9wb0lkLCBjb21waWxlQ29udGV4dCk7XG5cbiAgICAgICAgICAgIHN3aXRjaCAodGVzdC5vcGVyYXRvcikge1xuICAgICAgICAgICAgICAgIGNhc2UgJ2V4aXN0cyc6XG4gICAgICAgICAgICAgICAgICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtlbmRUb3BvSWRdID0gSnNMYW5nLmFzdE5vdChKc0xhbmcuYXN0Q2FsbCgnXy5pc0VtcHR5JywgYXN0QXJndW1lbnQpKTtcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgICAgICBjYXNlICdpcy1ub3QtbnVsbCc6XG4gICAgICAgICAgICAgICAgICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtlbmRUb3BvSWRdID0gSnNMYW5nLmFzdE5vdChKc0xhbmcuYXN0Q2FsbCgnXy5pc05pbCcsIGFzdEFyZ3VtZW50KSk7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgY2FzZSAnbm90LWV4aXN0cyc6XG4gICAgICAgICAgICAgICAgICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtlbmRUb3BvSWRdID0gSnNMYW5nLmFzdENhbGwoJ18uaXNFbXB0eScsIGFzdEFyZ3VtZW50KTtcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgICAgICBjYXNlICdpcy1udWxsJzpcbiAgICAgICAgICAgICAgICAgICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW2VuZFRvcG9JZF0gPSBKc0xhbmcuYXN0Q2FsbCgnXy5pc05pbCcsIGFzdEFyZ3VtZW50KTtcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgICAgICBjYXNlICdub3QnOlxuICAgICAgICAgICAgICAgICAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbZW5kVG9wb0lkXSA9IEpzTGFuZy5hc3ROb3QoYXN0QXJndW1lbnQpO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5zdXBwb3J0ZWQgdGVzdCBvcGVyYXRvcjogJyArIHRlc3Qub3BlcmF0b3IpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gZW5kVG9wb0lkO1xuXG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBsZXQgdmFsdWVTdGFydFRvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgc3RhcnRUb3BvSWQgKyAnJHZhbHVlJyk7XG4gICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkLCB2YWx1ZVN0YXJ0VG9wb0lkKTtcbiAgICAgICAgICAgIHJldHVybiBjb21waWxlQ29uY3JldGVWYWx1ZUV4cHJlc3Npb24odmFsdWVTdGFydFRvcG9JZCwgdGVzdCwgY29tcGlsZUNvbnRleHQpO1xuICAgICAgICB9IFxuICAgIH1cblxuICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtzdGFydFRvcG9JZF0gPSBKc0xhbmcuYXN0VmFsdWUodGVzdCk7XG4gICAgcmV0dXJuIHN0YXJ0VG9wb0lkO1xufVxuXG4vKipcbiAqIENvbXBpbGUgYSB2YWxpZGF0b3IgY2FsbGVkIGluIGEgbG9naWNhbCBleHByZXNzaW9uLlxuICogQHBhcmFtIHZhbHVlXG4gKiBAcGFyYW0gZnVuY3RvcnNcbiAqIEBwYXJhbSBjb21waWxlQ29udGV4dFxuICogQHBhcmFtIHRvcG9JbmZvXG4gKiBAcHJvcGVydHkge3N0cmluZ30gdG9wb0luZm8udG9wb0lkUHJlZml4XG4gKiBAcHJvcGVydHkge3N0cmluZ30gdG9wb0luZm8ubGFzdFRvcG9JZFxuICogQHJldHVybnMgeyp8c3RyaW5nfVxuICovXG5mdW5jdGlvbiBjb21waWxlQWRIb2NWYWxpZGF0b3IodG9wb0lkLCB2YWx1ZSwgZnVuY3RvciwgY29tcGlsZUNvbnRleHQpIHtcbiAgICBhc3NlcnQ6IGZ1bmN0b3Iub29sVHlwZSA9PT0gT29sVHlwZXMuTW9kaWZpZXIuVkFMSURBVE9SOyAgICAgICAgXG5cbiAgICBsZXQgY2FsbEFyZ3M7XG4gICAgXG4gICAgaWYgKGZ1bmN0b3IuYXJncykge1xuICAgICAgICBjYWxsQXJncyA9IHRyYW5zbGF0ZUFyZ3ModG9wb0lkLCBmdW5jdG9yLmFyZ3MsIGNvbXBpbGVDb250ZXh0KTsgICAgICAgIFxuICAgIH0gZWxzZSB7XG4gICAgICAgIGNhbGxBcmdzID0gW107XG4gICAgfSAgICAgICAgICAgIFxuICAgIFxuICAgIGxldCBhcmcwID0gdmFsdWU7XG4gICAgXG4gICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW3RvcG9JZF0gPSBKc0xhbmcuYXN0Q2FsbCgnVmFsaWRhdG9ycy4nICsgZnVuY3Rvci5uYW1lLCBbIGFyZzAgXS5jb25jYXQoY2FsbEFyZ3MpKTtcblxuICAgIHJldHVybiB0b3BvSWQ7XG59XG5cbi8qKlxuICogQ29tcGlsZSBhIG1vZGlmaWVyIGZyb20gb29sIHRvIGFzdC5cbiAqIEBwYXJhbSB0b3BvSWQgLSBzdGFydFRvcG9JZFxuICogQHBhcmFtIHZhbHVlXG4gKiBAcGFyYW0gZnVuY3RvcnNcbiAqIEBwYXJhbSBjb21waWxlQ29udGV4dFxuICogQHBhcmFtIHRvcG9JbmZvXG4gKiBAcHJvcGVydHkge3N0cmluZ30gdG9wb0luZm8udG9wb0lkUHJlZml4XG4gKiBAcHJvcGVydHkge3N0cmluZ30gdG9wb0luZm8ubGFzdFRvcG9JZFxuICogQHJldHVybnMgeyp8c3RyaW5nfVxuICovXG5mdW5jdGlvbiBjb21waWxlTW9kaWZpZXIodG9wb0lkLCB2YWx1ZSwgZnVuY3RvciwgY29tcGlsZUNvbnRleHQpIHtcbiAgICBsZXQgZGVjbGFyZVBhcmFtcztcblxuICAgIGlmIChmdW5jdG9yLm9vbFR5cGUgPT09IE9vbFR5cGVzLk1vZGlmaWVyLkFDVElWQVRPUikgeyBcbiAgICAgICAgZGVjbGFyZVBhcmFtcyA9IHRyYW5zbGF0ZUZ1bmN0aW9uUGFyYW1zKGZ1bmN0b3IuYXJncyk7ICAgICAgICBcbiAgICB9IGVsc2Uge1xuICAgICAgICBkZWNsYXJlUGFyYW1zID0gdHJhbnNsYXRlRnVuY3Rpb25QYXJhbXMoXy5pc0VtcHR5KGZ1bmN0b3IuYXJncykgPyBbdmFsdWVdIDogW3ZhbHVlXS5jb25jYXQoZnVuY3Rvci5hcmdzKSk7ICAgICAgICBcbiAgICB9ICAgICAgICBcblxuICAgIGxldCBmdW5jdG9ySWQgPSB0cmFuc2xhdGVNb2RpZmllcihmdW5jdG9yLCBjb21waWxlQ29udGV4dCwgZGVjbGFyZVBhcmFtcyk7XG5cbiAgICBsZXQgY2FsbEFyZ3MsIHJlZmVyZW5jZXM7XG4gICAgXG4gICAgaWYgKGZ1bmN0b3IuYXJncykge1xuICAgICAgICBjYWxsQXJncyA9IHRyYW5zbGF0ZUFyZ3ModG9wb0lkLCBmdW5jdG9yLmFyZ3MsIGNvbXBpbGVDb250ZXh0KTtcbiAgICAgICAgcmVmZXJlbmNlcyA9IGV4dHJhY3RSZWZlcmVuY2VkRmllbGRzKGZ1bmN0b3IuYXJncyk7XG5cbiAgICAgICAgaWYgKF8uZmluZChyZWZlcmVuY2VzLCByZWYgPT4gcmVmID09PSB2YWx1ZS5uYW1lKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdDYW5ub3QgdXNlIHRoZSB0YXJnZXQgZmllbGQgaXRzZWxmIGFzIGFuIGFyZ3VtZW50IG9mIGEgbW9kaWZpZXIuJyk7XG4gICAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgICBjYWxsQXJncyA9IFtdO1xuICAgIH0gICAgICAgIFxuICAgIFxuICAgIGlmIChmdW5jdG9yLm9vbFR5cGUgPT09IE9vbFR5cGVzLk1vZGlmaWVyLkFDVElWQVRPUikgeyAgICAgICAgICAgIFxuICAgICAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbdG9wb0lkXSA9IEpzTGFuZy5hc3RDYWxsKGZ1bmN0b3JJZCwgY2FsbEFyZ3MpO1xuICAgIH0gZWxzZSB7XG4gICAgICAgIGxldCBhcmcwID0gdmFsdWU7XG4gICAgICAgIGlmICghaXNUb3BMZXZlbEJsb2NrKHRvcG9JZCkgJiYgXy5pc1BsYWluT2JqZWN0KHZhbHVlKSAmJiB2YWx1ZS5vb2xUeXBlID09PSAnT2JqZWN0UmVmZXJlbmNlJyAmJiB2YWx1ZS5uYW1lLnN0YXJ0c1dpdGgoJ2xhdGVzdC4nKSkge1xuICAgICAgICAgICAgLy9sZXQgZXhpc3RpbmdSZWYgPSAgICAgICAgICAgIFxuICAgICAgICAgICAgYXJnMCA9IEpzTGFuZy5hc3RDb25kaXRpb25hbChcbiAgICAgICAgICAgICAgICBKc0xhbmcuYXN0Q2FsbCgnbGF0ZXN0Lmhhc093blByb3BlcnR5JywgWyBleHRyYWN0UmVmZXJlbmNlQmFzZU5hbWUodmFsdWUubmFtZSkgXSksIC8qKiB0ZXN0ICovXG4gICAgICAgICAgICAgICAgdmFsdWUsIC8qKiBjb25zZXF1ZW50ICovXG4gICAgICAgICAgICAgICAgcmVwbGFjZVZhclJlZlNjb3BlKHZhbHVlLCAnZXhpc3RpbmcnKVxuICAgICAgICAgICAgKTsgIFxuICAgICAgICB9XG4gICAgICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFt0b3BvSWRdID0gSnNMYW5nLmFzdENhbGwoZnVuY3RvcklkLCBbIGFyZzAgXS5jb25jYXQoY2FsbEFyZ3MpKTtcbiAgICB9ICAgIFxuXG4gICAgaWYgKGlzVG9wTGV2ZWxCbG9jayh0b3BvSWQpKSB7XG4gICAgICAgIGxldCB0YXJnZXRWYXJOYW1lID0gdmFsdWUubmFtZTtcbiAgICAgICAgbGV0IG5lZWREZWNsYXJlID0gZmFsc2U7XG5cbiAgICAgICAgaWYgKCFpc0RvdFNlcGFyYXRlTmFtZSh2YWx1ZS5uYW1lKSAmJiBjb21waWxlQ29udGV4dC52YXJpYWJsZXNbdmFsdWUubmFtZV0gJiYgZnVuY3Rvci5vb2xUeXBlICE9PSBPb2xUeXBlcy5Nb2RpZmllci5WQUxJREFUT1IpIHtcbiAgICAgICAgICAgIC8vY29uZmxpY3Qgd2l0aCBleGlzdGluZyB2YXJpYWJsZXMsIG5lZWQgdG8gcmVuYW1lIHRvIGFub3RoZXIgdmFyaWFibGVcbiAgICAgICAgICAgIGxldCBjb3VudGVyID0gMTtcbiAgICAgICAgICAgIGRvIHtcbiAgICAgICAgICAgICAgICBjb3VudGVyKys7ICAgICAgIFxuICAgICAgICAgICAgICAgIHRhcmdldFZhck5hbWUgPSB2YWx1ZS5uYW1lICsgY291bnRlci50b1N0cmluZygpOyAgICAgICAgIFxuICAgICAgICAgICAgfSB3aGlsZSAoY29tcGlsZUNvbnRleHQudmFyaWFibGVzLmhhc093blByb3BlcnR5KHRhcmdldFZhck5hbWUpKTsgICAgICAgICAgICBcblxuICAgICAgICAgICAgY29tcGlsZUNvbnRleHQudmFyaWFibGVzW3RhcmdldFZhck5hbWVdID0geyB0eXBlOiAnbG9jYWxWYXJpYWJsZScsIHNvdXJjZTogJ21vZGlmaWVyJyB9O1xuICAgICAgICAgICAgbmVlZERlY2xhcmUgPSB0cnVlO1xuICAgICAgICB9XG5cbiAgICAgICAgLy9pZiAoY29tcGlsZUNvbnRleHQudmFyaWFibGVzW10pXG5cbiAgICAgICAgYWRkQ29kZUJsb2NrKGNvbXBpbGVDb250ZXh0LCB0b3BvSWQsIHtcbiAgICAgICAgICAgIHR5cGU6IE9PTF9NT0RJRklFUl9DT0RFX0ZMQUdbZnVuY3Rvci5vb2xUeXBlXSxcbiAgICAgICAgICAgIHRhcmdldDogdGFyZ2V0VmFyTmFtZSxcbiAgICAgICAgICAgIHJlZmVyZW5jZXMsICAgLy8gbGF0ZXN0LiwgZXhzaXRpbmcuLCByYXcuXG4gICAgICAgICAgICBuZWVkRGVjbGFyZVxuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICByZXR1cm4gdG9wb0lkO1xufSAgXG4gICAgICBcbmZ1bmN0aW9uIGV4dHJhY3RSZWZlcmVuY2VkRmllbGRzKG9vbEFyZ3MpIHsgICBcbiAgICBvb2xBcmdzID0gXy5jYXN0QXJyYXkob29sQXJncyk7ICAgIFxuXG4gICAgbGV0IHJlZnMgPSBbXTtcblxuICAgIG9vbEFyZ3MuZm9yRWFjaChhID0+IHtcbiAgICAgICAgbGV0IHJlc3VsdCA9IGNoZWNrUmVmZXJlbmNlVG9GaWVsZChhKTtcbiAgICAgICAgaWYgKHJlc3VsdCkge1xuICAgICAgICAgICAgcmVmcy5wdXNoKHJlc3VsdCk7XG4gICAgICAgIH1cbiAgICB9KTtcblxuICAgIHJldHVybiByZWZzO1xufVxuXG5mdW5jdGlvbiBjaGVja1JlZmVyZW5jZVRvRmllbGQob2JqKSB7XG4gICAgaWYgKF8uaXNQbGFpbk9iamVjdChvYmopICYmIG9iai5vb2xUeXBlKSB7XG4gICAgICAgIGlmIChvYmoub29sVHlwZSA9PT0gJ1BpcGVkVmFsdWUnKSByZXR1cm4gY2hlY2tSZWZlcmVuY2VUb0ZpZWxkKG9iai52YWx1ZSk7XG4gICAgICAgIGlmIChvYmoub29sVHlwZSA9PT0gJ09iamVjdFJlZmVyZW5jZScpIHtcbiAgICAgICAgICAgIHJldHVybiBvYmoubmFtZTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHJldHVybiB1bmRlZmluZWQ7XG59XG5cbmZ1bmN0aW9uIGFkZE1vZGlmaWVyVG9NYXAoZnVuY3RvcklkLCBmdW5jdG9yVHlwZSwgZnVuY3RvckpzRmlsZSwgbWFwT2ZGdW5jdG9yVG9GaWxlKSB7XG4gICAgaWYgKG1hcE9mRnVuY3RvclRvRmlsZVtmdW5jdG9ySWRdICYmIG1hcE9mRnVuY3RvclRvRmlsZVtmdW5jdG9ySWRdICE9PSBmdW5jdG9ySnNGaWxlKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgQ29uZmxpY3Q6ICR7ZnVuY3RvclR5cGV9IG5hbWluZyBcIiR7ZnVuY3RvcklkfVwiIGNvbmZsaWN0cyFgKTtcbiAgICB9XG4gICAgbWFwT2ZGdW5jdG9yVG9GaWxlW2Z1bmN0b3JJZF0gPSBmdW5jdG9ySnNGaWxlO1xufVxuXG4vKipcbiAqIENoZWNrIHdoZXRoZXIgYSBmdW5jdG9yIGlzIHVzZXItZGVmaW5lZCBvciBidWlsdC1pblxuICogQHBhcmFtIGZ1bmN0b3JcbiAqIEBwYXJhbSBjb21waWxlQ29udGV4dFxuICogQHBhcmFtIGFyZ3MgLSBVc2VkIHRvIG1ha2UgdXAgdGhlIGZ1bmN0aW9uIHNpZ25hdHVyZVxuICogQHJldHVybnMge3N0cmluZ30gZnVuY3RvciBpZFxuICovXG5mdW5jdGlvbiB0cmFuc2xhdGVNb2RpZmllcihmdW5jdG9yLCBjb21waWxlQ29udGV4dCwgYXJncykge1xuICAgIGxldCBmdW5jdGlvbk5hbWUsIGZpbGVOYW1lLCBmdW5jdG9ySWQ7XG5cbiAgICAvL2V4dHJhY3QgdmFsaWRhdG9yIG5hbWluZyBhbmQgaW1wb3J0IGluZm9ybWF0aW9uXG4gICAgaWYgKGlzRG90U2VwYXJhdGVOYW1lKGZ1bmN0b3IubmFtZSkpIHtcbiAgICAgICAgbGV0IG5hbWVzID0gZXh0cmFjdERvdFNlcGFyYXRlTmFtZShmdW5jdG9yLm5hbWUpO1xuICAgICAgICBpZiAobmFtZXMubGVuZ3RoID4gMikge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdOb3Qgc3VwcG9ydGVkIHJlZmVyZW5jZSB0eXBlOiAnICsgZnVuY3Rvci5uYW1lKTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vcmVmZXJlbmNlIHRvIG90aGVyIGVudGl0eSBmaWxlXG4gICAgICAgIGxldCByZWZFbnRpdHlOYW1lID0gbmFtZXNbMF07XG4gICAgICAgIGZ1bmN0aW9uTmFtZSA9IG5hbWVzWzFdO1xuICAgICAgICBmaWxlTmFtZSA9ICcuLycgKyBPT0xfTU9ESUZJRVJfUEFUSFtmdW5jdG9yLm9vbFR5cGVdICsgJy8nICsgcmVmRW50aXR5TmFtZSArICctJyArIGZ1bmN0aW9uTmFtZSArICcuanMnO1xuICAgICAgICBmdW5jdG9ySWQgPSByZWZFbnRpdHlOYW1lICsgXy51cHBlckZpcnN0KGZ1bmN0aW9uTmFtZSk7XG4gICAgICAgIGFkZE1vZGlmaWVyVG9NYXAoZnVuY3RvcklkLCBmdW5jdG9yLm9vbFR5cGUsIGZpbGVOYW1lLCBjb21waWxlQ29udGV4dC5tYXBPZkZ1bmN0b3JUb0ZpbGUpO1xuXG4gICAgfSBlbHNlIHtcbiAgICAgICAgZnVuY3Rpb25OYW1lID0gZnVuY3Rvci5uYW1lO1xuXG4gICAgICAgIGxldCBidWlsdGlucyA9IE9PTF9NT0RJRklFUl9CVUlMVElOW2Z1bmN0b3Iub29sVHlwZV07XG5cbiAgICAgICAgaWYgKCEoZnVuY3Rpb25OYW1lIGluIGJ1aWx0aW5zKSkge1xuICAgICAgICAgICAgZmlsZU5hbWUgPSAnLi8nICsgT09MX01PRElGSUVSX1BBVEhbZnVuY3Rvci5vb2xUeXBlXSArICcvJyArIGNvbXBpbGVDb250ZXh0Lm1vZHVsZU5hbWUgKyAnLScgKyBmdW5jdGlvbk5hbWUgKyAnLmpzJztcbiAgICAgICAgICAgIGZ1bmN0b3JJZCA9IGZ1bmN0aW9uTmFtZTtcblxuICAgICAgICAgICAgaWYgKCFjb21waWxlQ29udGV4dC5tYXBPZkZ1bmN0b3JUb0ZpbGVbZnVuY3RvcklkXSkge1xuICAgICAgICAgICAgICAgIGNvbXBpbGVDb250ZXh0Lm5ld0Z1bmN0b3JGaWxlcy5wdXNoKHtcbiAgICAgICAgICAgICAgICAgICAgZnVuY3Rpb25OYW1lLFxuICAgICAgICAgICAgICAgICAgICBmdW5jdG9yVHlwZTogZnVuY3Rvci5vb2xUeXBlLFxuICAgICAgICAgICAgICAgICAgICBmaWxlTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgYXJnc1xuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBhZGRNb2RpZmllclRvTWFwKGZ1bmN0b3JJZCwgZnVuY3Rvci5vb2xUeXBlLCBmaWxlTmFtZSwgY29tcGlsZUNvbnRleHQubWFwT2ZGdW5jdG9yVG9GaWxlKTsgICAgICAgICAgICBcbiAgICAgICAgfSBlbHNlIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIGZ1bmN0b3JJZCA9IGZ1bmN0b3Iub29sVHlwZSArICdzLicgKyBmdW5jdGlvbk5hbWU7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICByZXR1cm4gZnVuY3RvcklkO1xufVxuXG4vKipcbiAqIENvbXBpbGUgYSBwaXBlZCB2YWx1ZSBmcm9tIG9vbCB0byBhc3QuXG4gKiBAcGFyYW0ge3N0cmluZ30gc3RhcnRUb3BvSWQgLSBUaGUgdG9wb2xvZ2ljYWwgaWQgb2YgdGhlIHN0YXJ0aW5nIHByb2Nlc3MgdG8gdGhlIHRhcmdldCB2YWx1ZSwgZGVmYXVsdCBhcyB0aGUgcGFyYW0gbmFtZVxuICogQHBhcmFtIHtvYmplY3R9IHZhck9vbCAtIFRhcmdldCB2YWx1ZSBvb2wgbm9kZS5cbiAqIEBwYXJhbSB7b2JqZWN0fSBjb21waWxlQ29udGV4dCAtIENvbXBpbGF0aW9uIGNvbnRleHQuXG4gKiBAcHJvcGVydHkge3N0cmluZ30gY29tcGlsZUNvbnRleHQubW9kdWxlTmFtZVxuICogQHByb3BlcnR5IHtUb3BvU29ydH0gY29tcGlsZUNvbnRleHQudG9wb1NvcnRcbiAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBjb21waWxlQ29udGV4dC5hc3RNYXAgLSBUb3BvIElkIHRvIGFzdCBtYXBcbiAqIEByZXR1cm5zIHtzdHJpbmd9IExhc3QgdG9wbyBJZFxuICovXG5mdW5jdGlvbiBjb21waWxlUGlwZWRWYWx1ZShzdGFydFRvcG9JZCwgdmFyT29sLCBjb21waWxlQ29udGV4dCkge1xuICAgIGxldCBsYXN0VG9wb0lkID0gY29tcGlsZUNvbmNyZXRlVmFsdWVFeHByZXNzaW9uKHN0YXJ0VG9wb0lkLCB2YXJPb2wudmFsdWUsIGNvbXBpbGVDb250ZXh0KTtcblxuICAgIHZhck9vbC5tb2RpZmllcnMuZm9yRWFjaChtb2RpZmllciA9PiB7XG4gICAgICAgIGxldCBtb2RpZmllclN0YXJ0VG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBzdGFydFRvcG9JZCArIE9PTF9NT0RJRklFUl9PUFttb2RpZmllci5vb2xUeXBlXSArIG1vZGlmaWVyLm5hbWUpO1xuICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIGxhc3RUb3BvSWQsIG1vZGlmaWVyU3RhcnRUb3BvSWQpO1xuXG4gICAgICAgIGxhc3RUb3BvSWQgPSBjb21waWxlTW9kaWZpZXIoXG4gICAgICAgICAgICBtb2RpZmllclN0YXJ0VG9wb0lkLFxuICAgICAgICAgICAgdmFyT29sLnZhbHVlLFxuICAgICAgICAgICAgbW9kaWZpZXIsXG4gICAgICAgICAgICBjb21waWxlQ29udGV4dFxuICAgICAgICApO1xuICAgIH0pO1xuXG4gICAgcmV0dXJuIGxhc3RUb3BvSWQ7XG59XG5cbi8qKlxuICogQ29tcGlsZSBhIHZhcmlhYmxlIHJlZmVyZW5jZSBmcm9tIG9vbCB0byBhc3QuXG4gKiBAcGFyYW0ge3N0cmluZ30gc3RhcnRUb3BvSWQgLSBUaGUgdG9wb2xvZ2ljYWwgaWQgb2YgdGhlIHN0YXJ0aW5nIHByb2Nlc3MgdG8gdGhlIHRhcmdldCB2YWx1ZSwgZGVmYXVsdCBhcyB0aGUgcGFyYW0gbmFtZVxuICogQHBhcmFtIHtvYmplY3R9IHZhck9vbCAtIFRhcmdldCB2YWx1ZSBvb2wgbm9kZS5cbiAqIEBwYXJhbSB7b2JqZWN0fSBjb21waWxlQ29udGV4dCAtIENvbXBpbGF0aW9uIGNvbnRleHQuXG4gKiBAcHJvcGVydHkge3N0cmluZ30gY29tcGlsZUNvbnRleHQubW9kdWxlTmFtZVxuICogQHByb3BlcnR5IHtUb3BvU29ydH0gY29tcGlsZUNvbnRleHQudG9wb1NvcnRcbiAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBjb21waWxlQ29udGV4dC5hc3RNYXAgLSBUb3BvIElkIHRvIGFzdCBtYXBcbiAqIEByZXR1cm5zIHtzdHJpbmd9IExhc3QgdG9wbyBJZFxuICovXG5mdW5jdGlvbiBjb21waWxlVmFyaWFibGVSZWZlcmVuY2Uoc3RhcnRUb3BvSWQsIHZhck9vbCwgY29tcGlsZUNvbnRleHQpIHtcbiAgICBwcmU6IF8uaXNQbGFpbk9iamVjdCh2YXJPb2wpICYmIHZhck9vbC5vb2xUeXBlID09PSAnT2JqZWN0UmVmZXJlbmNlJztcblxuICAgIC8vbGV0IFsgYmFzZU5hbWUsIG90aGVycyBdID0gdmFyT29sLm5hbWUuc3BsaXQoJy4nLCAyKTtcbiAgICAvKlxuICAgIGlmIChjb21waWxlQ29udGV4dC5tb2RlbFZhcnMgJiYgY29tcGlsZUNvbnRleHQubW9kZWxWYXJzLmhhcyhiYXNlTmFtZSkgJiYgb3RoZXJzKSB7XG4gICAgICAgIHZhck9vbC5uYW1lID0gYmFzZU5hbWUgKyAnLmRhdGEnICsgJy4nICsgb3RoZXJzO1xuICAgIH0qLyAgICBcblxuICAgIC8vc2ltcGxlIHZhbHVlXG4gICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW3N0YXJ0VG9wb0lkXSA9IEpzTGFuZy5hc3RWYWx1ZSh2YXJPb2wpO1xuICAgIHJldHVybiBzdGFydFRvcG9JZDtcbn1cblxuLyoqXG4gKiBHZXQgYW4gYXJyYXkgb2YgcGFyYW1ldGVyIG5hbWVzLlxuICogQHBhcmFtIHthcnJheX0gYXJncyAtIEFuIGFycmF5IG9mIGFyZ3VtZW50cyBpbiBvb2wgc3ludGF4XG4gKiBAcmV0dXJucyB7YXJyYXl9XG4gKi9cbmZ1bmN0aW9uIHRyYW5zbGF0ZUZ1bmN0aW9uUGFyYW1zKGFyZ3MpIHtcbiAgICBpZiAoXy5pc0VtcHR5KGFyZ3MpKSByZXR1cm4gW107XG5cbiAgICBsZXQgbmFtZXMgPSBuZXcgU2V0KCk7XG5cbiAgICBmdW5jdGlvbiB0cmFuc2xhdGVGdW5jdGlvblBhcmFtKGFyZywgaSkge1xuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGFyZykpIHtcbiAgICAgICAgICAgIGlmIChhcmcub29sVHlwZSA9PT0gJ1BpcGVkVmFsdWUnKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHRyYW5zbGF0ZUZ1bmN0aW9uUGFyYW0oYXJnLnZhbHVlKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGFyZy5vb2xUeXBlID09PSAnT2JqZWN0UmVmZXJlbmNlJykge1xuICAgICAgICAgICAgICAgIGlmIChpc0RvdFNlcGFyYXRlTmFtZShhcmcubmFtZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGV4dHJhY3REb3RTZXBhcmF0ZU5hbWUoYXJnLm5hbWUpLnBvcCgpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gICAgICAgICAgICBcblxuICAgICAgICAgICAgcmV0dXJuIGFyZy5uYW1lO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuICdwYXJhbScgKyAoaSArIDEpLnRvU3RyaW5nKCk7XG4gICAgfVxuXG4gICAgcmV0dXJuIF8ubWFwKGFyZ3MsIChhcmcsIGkpID0+IHtcbiAgICAgICAgbGV0IGJhc2VOYW1lID0gdHJhbnNsYXRlRnVuY3Rpb25QYXJhbShhcmcsIGkpO1xuICAgICAgICBsZXQgbmFtZSA9IGJhc2VOYW1lO1xuICAgICAgICBsZXQgY291bnQgPSAyO1xuICAgICAgICBcbiAgICAgICAgd2hpbGUgKG5hbWVzLmhhcyhuYW1lKSkge1xuICAgICAgICAgICAgbmFtZSA9IGJhc2VOYW1lICsgY291bnQudG9TdHJpbmcoKTtcbiAgICAgICAgICAgIGNvdW50Kys7XG4gICAgICAgIH1cblxuICAgICAgICBuYW1lcy5hZGQobmFtZSk7XG4gICAgICAgIHJldHVybiBuYW1lOyAgICAgICAgXG4gICAgfSk7XG59XG5cbi8qKlxuICogQ29tcGlsZSBhIGNvbmNyZXRlIHZhbHVlIGV4cHJlc3Npb24gZnJvbSBvb2wgdG8gYXN0XG4gKiBAcGFyYW0ge3N0cmluZ30gc3RhcnRUb3BvSWQgLSBUaGUgdG9wbyBpZCBvZiB0aGUgc3RhcnRpbmcgcHJvY2VzcyB0byB0aGUgdGFyZ2V0IHZhbHVlIGV4cHJlc3Npb25cbiAqIEBwYXJhbSB7b2JqZWN0fSB2YWx1ZSAtIE9vbCBub2RlXG4gKiBAcGFyYW0ge29iamVjdH0gY29tcGlsZUNvbnRleHQgLSBDb21waWxhdGlvbiBjb250ZXh0XG4gKiBAcmV0dXJucyB7c3RyaW5nfSBMYXN0IHRvcG9JZFxuICovXG5mdW5jdGlvbiBjb21waWxlQ29uY3JldGVWYWx1ZUV4cHJlc3Npb24oc3RhcnRUb3BvSWQsIHZhbHVlLCBjb21waWxlQ29udGV4dCkge1xuICAgIGlmIChfLmlzUGxhaW5PYmplY3QodmFsdWUpKSB7XG4gICAgICAgIGlmICh2YWx1ZS5vb2xUeXBlID09PSAnUGlwZWRWYWx1ZScpIHtcbiAgICAgICAgICAgIHJldHVybiBjb21waWxlUGlwZWRWYWx1ZShzdGFydFRvcG9JZCwgdmFsdWUsIGNvbXBpbGVDb250ZXh0KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICh2YWx1ZS5vb2xUeXBlID09PSAnT2JqZWN0UmVmZXJlbmNlJykge1xuICAgICAgICAgICAgbGV0IFsgcmVmQmFzZSwgLi4ucmVzdCBdID0gZXh0cmFjdERvdFNlcGFyYXRlTmFtZSh2YWx1ZS5uYW1lKTtcblxuICAgICAgICAgICAgbGV0IGRlcGVuZGVuY3k7XG5cbiAgICAgICAgICAgIGlmICghY29tcGlsZUNvbnRleHQudmFyaWFibGVzW3JlZkJhc2VdKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBSZWZlcmVuY2VkIHVuZGVmaW5lZCB2YXJpYWJsZTogJHt2YWx1ZS5uYW1lfWApOyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgIGlmIChjb21waWxlQ29udGV4dC52YXJpYWJsZXNbcmVmQmFzZV0udHlwZSA9PT0gJ2VudGl0eScgJiYgIWNvbXBpbGVDb250ZXh0LnZhcmlhYmxlc1tyZWZCYXNlXS5vbmdvaW5nKSB7XG4gICAgICAgICAgICAgICAgZGVwZW5kZW5jeSA9IHJlZkJhc2U7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKHJlZkJhc2UgPT09ICdsYXRlc3QnICYmIHJlc3QubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgICAgIC8vbGF0ZXN0LnBhc3N3b3JkXG4gICAgICAgICAgICAgICAgbGV0IHJlZkZpZWxkTmFtZSA9IHJlc3QucG9wKCk7XG4gICAgICAgICAgICAgICAgaWYgKHJlZkZpZWxkTmFtZSAhPT0gc3RhcnRUb3BvSWQpIHtcbiAgICAgICAgICAgICAgICAgICAgZGVwZW5kZW5jeSA9IHJlZkZpZWxkTmFtZSArICc6cmVhZHknO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSBpZiAoXy5pc0VtcHR5KHJlc3QpKSB7XG4gICAgICAgICAgICAgICAgZGVwZW5kZW5jeSA9IHJlZkJhc2UgKyAnOnJlYWR5JztcbiAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgIGlmIChkZXBlbmRlbmN5KSB7XG4gICAgICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBkZXBlbmRlbmN5LCBzdGFydFRvcG9JZCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiBjb21waWxlVmFyaWFibGVSZWZlcmVuY2Uoc3RhcnRUb3BvSWQsIHZhbHVlLCBjb21waWxlQ29udGV4dCk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAodmFsdWUub29sVHlwZSA9PT0gJ1JlZ0V4cCcpIHtcbiAgICAgICAgICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtzdGFydFRvcG9JZF0gPSBKc0xhbmcuYXN0VmFsdWUodmFsdWUpOyAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIHN0YXJ0VG9wb0lkO1xuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICB2YWx1ZSA9IF8ubWFwVmFsdWVzKHZhbHVlLCAodmFsdWVPZkVsZW1lbnQsIGtleSkgPT4geyBcbiAgICAgICAgICAgIGxldCBzaWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkICsgJy4nICsga2V5KTtcbiAgICAgICAgICAgIGxldCBlaWQgPSBjb21waWxlQ29uY3JldGVWYWx1ZUV4cHJlc3Npb24oc2lkLCB2YWx1ZU9mRWxlbWVudCwgY29tcGlsZUNvbnRleHQpO1xuICAgICAgICAgICAgaWYgKHNpZCAhPT0gZWlkKSB7XG4gICAgICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBlaWQsIHN0YXJ0VG9wb0lkKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiBjb21waWxlQ29udGV4dC5hc3RNYXBbZWlkXTtcbiAgICAgICAgfSk7XG4gICAgfSBlbHNlIGlmIChBcnJheS5pc0FycmF5KHZhbHVlKSkge1xuICAgICAgICB2YWx1ZSA9IF8ubWFwKHZhbHVlLCAodmFsdWVPZkVsZW1lbnQsIGluZGV4KSA9PiB7IFxuICAgICAgICAgICAgbGV0IHNpZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgc3RhcnRUb3BvSWQgKyAnWycgKyBpbmRleCArICddJyk7XG4gICAgICAgICAgICBsZXQgZWlkID0gY29tcGlsZUNvbmNyZXRlVmFsdWVFeHByZXNzaW9uKHNpZCwgdmFsdWVPZkVsZW1lbnQsIGNvbXBpbGVDb250ZXh0KTtcbiAgICAgICAgICAgIGlmIChzaWQgIT09IGVpZCkge1xuICAgICAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgZWlkLCBzdGFydFRvcG9JZCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gY29tcGlsZUNvbnRleHQuYXN0TWFwW2VpZF07XG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtzdGFydFRvcG9JZF0gPSBKc0xhbmcuYXN0VmFsdWUodmFsdWUpO1xuICAgIHJldHVybiBzdGFydFRvcG9JZDtcbn1cblxuLyoqXG4gKiBUcmFuc2xhdGUgYW4gYXJyYXkgb2YgZnVuY3Rpb24gYXJndW1lbnRzIGZyb20gb29sIGludG8gYXN0LlxuICogQHBhcmFtIHRvcG9JZCAtIFRoZSBtb2RpZmllciBmdW5jdGlvbiB0b3BvIFxuICogQHBhcmFtIGFyZ3MgLSBcbiAqIEBwYXJhbSBjb21waWxlQ29udGV4dCAtIFxuICogQHJldHVybnMge0FycmF5fVxuICovXG5mdW5jdGlvbiB0cmFuc2xhdGVBcmdzKHRvcG9JZCwgYXJncywgY29tcGlsZUNvbnRleHQpIHtcbiAgICBhcmdzID0gXy5jYXN0QXJyYXkoYXJncyk7XG4gICAgaWYgKF8uaXNFbXB0eShhcmdzKSkgcmV0dXJuIFtdO1xuXG4gICAgbGV0IGNhbGxBcmdzID0gW107XG5cbiAgICBfLmVhY2goYXJncywgKGFyZywgaSkgPT4geyAgICAgICAgICAgICAgICBcbiAgICAgICAgbGV0IGFyZ1RvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgdG9wb0lkICsgJzphcmdbJyArIChpKzEpLnRvU3RyaW5nKCkgKyAnXScpO1xuICAgICAgICBsZXQgbGFzdFRvcG9JZCA9IGNvbXBpbGVDb25jcmV0ZVZhbHVlRXhwcmVzc2lvbihhcmdUb3BvSWQsIGFyZywgY29tcGlsZUNvbnRleHQpO1xuXG4gICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgbGFzdFRvcG9JZCwgdG9wb0lkKTtcblxuICAgICAgICBjYWxsQXJncyA9IGNhbGxBcmdzLmNvbmNhdChfLmNhc3RBcnJheShnZXRDb2RlUmVwcmVzZW50YXRpb25PZihsYXN0VG9wb0lkLCBjb21waWxlQ29udGV4dCkpKTtcbiAgICB9KTtcblxuICAgIHJldHVybiBjYWxsQXJncztcbn1cblxuLyoqXG4gKiBDb21waWxlIGEgcGFyYW0gb2YgaW50ZXJmYWNlIGZyb20gb29sIGludG8gYXN0XG4gKiBAcGFyYW0gaW5kZXhcbiAqIEBwYXJhbSBwYXJhbVxuICogQHBhcmFtIGNvbXBpbGVDb250ZXh0XG4gKiBAcmV0dXJucyB7c3RyaW5nfVxuICovXG5mdW5jdGlvbiBjb21waWxlUGFyYW0oaW5kZXgsIHBhcmFtLCBjb21waWxlQ29udGV4dCkge1xuICAgIGxldCB0eXBlID0gcGFyYW0udHlwZTsgICAgXG5cbiAgICBsZXQgdHlwZU9iamVjdCA9IFR5cGVzW3R5cGVdO1xuXG4gICAgaWYgKCF0eXBlT2JqZWN0KSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcignVW5rbm93biBmaWVsZCB0eXBlOiAnICsgdHlwZSk7XG4gICAgfVxuXG4gICAgbGV0IHNhbml0aXplck5hbWUgPSBgVHlwZXMuJHt0eXBlLnRvVXBwZXJDYXNlKCl9LnNhbml0aXplYDtcblxuICAgIGxldCB2YXJSZWYgPSBKc0xhbmcuYXN0VmFyUmVmKHBhcmFtLm5hbWUpO1xuICAgIGxldCBjYWxsQXN0ID0gSnNMYW5nLmFzdENhbGwoc2FuaXRpemVyTmFtZSwgW3ZhclJlZiwgSnNMYW5nLmFzdEFycmF5QWNjZXNzKCckbWV0YS5wYXJhbXMnLCBpbmRleCksIEpzTGFuZy5hc3RWYXJSZWYoJ3RoaXMuZGIuaTE4bicpXSk7XG5cbiAgICBsZXQgcHJlcGFyZVRvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgJyRwYXJhbXM6c2FuaXRpemVbJyArIGluZGV4LnRvU3RyaW5nKCkgKyAnXScpO1xuICAgIC8vbGV0IHNhbml0aXplU3RhcnRpbmc7XG5cbiAgICAvL2lmIChpbmRleCA9PT0gMCkge1xuICAgICAgICAvL2RlY2xhcmUgJHNhbml0aXplU3RhdGUgdmFyaWFibGUgZm9yIHRoZSBmaXJzdCB0aW1lXG4gICAgLy8gICAgc2FuaXRpemVTdGFydGluZyA9IEpzTGFuZy5hc3RWYXJEZWNsYXJlKHZhclJlZiwgY2FsbEFzdCwgZmFsc2UsIGZhbHNlLCBgU2FuaXRpemUgcGFyYW0gXCIke3BhcmFtLm5hbWV9XCJgKTtcbiAgICAvL30gZWxzZSB7XG4gICAgLy9sZXQgc2FuaXRpemVTdGFydGluZyA9IDtcblxuICAgICAgICAvL2xldCBsYXN0UHJlcGFyZVRvcG9JZCA9ICckcGFyYW1zOnNhbml0aXplWycgKyAoaW5kZXggLSAxKS50b1N0cmluZygpICsgJ10nO1xuICAgICAgICAvL2RlcGVuZHNPbihjb21waWxlQ29udGV4dCwgbGFzdFByZXBhcmVUb3BvSWQsIHByZXBhcmVUb3BvSWQpO1xuICAgIC8vfVxuXG4gICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW3ByZXBhcmVUb3BvSWRdID0gW1xuICAgICAgICBKc0xhbmcuYXN0QXNzaWduKHZhclJlZiwgY2FsbEFzdCwgYFNhbml0aXplIGFyZ3VtZW50IFwiJHtwYXJhbS5uYW1lfVwiYClcbiAgICBdO1xuXG4gICAgYWRkQ29kZUJsb2NrKGNvbXBpbGVDb250ZXh0LCBwcmVwYXJlVG9wb0lkLCB7XG4gICAgICAgIHR5cGU6IEFTVF9CTEtfUEFSQU1fU0FOSVRJWkVcbiAgICB9KTtcblxuICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgcHJlcGFyZVRvcG9JZCwgY29tcGlsZUNvbnRleHQubWFpblN0YXJ0SWQpO1xuXG4gICAgbGV0IHRvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgcGFyYW0ubmFtZSk7XG4gICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBjb21waWxlQ29udGV4dC5tYWluU3RhcnRJZCwgdG9wb0lkKTtcblxuICAgIGxldCB2YWx1ZSA9IHdyYXBQYXJhbVJlZmVyZW5jZShwYXJhbS5uYW1lLCBwYXJhbSk7XG4gICAgbGV0IGVuZFRvcG9JZCA9IGNvbXBpbGVWYXJpYWJsZVJlZmVyZW5jZSh0b3BvSWQsIHZhbHVlLCBjb21waWxlQ29udGV4dCk7XG5cbiAgICBsZXQgcmVhZHlUb3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIHRvcG9JZCArICc6cmVhZHknKTtcbiAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIGVuZFRvcG9JZCwgcmVhZHlUb3BvSWQpO1xuXG4gICAgcmV0dXJuIHJlYWR5VG9wb0lkO1xufVxuXG4vKipcbiAqIENvbXBpbGUgYSBtb2RlbCBmaWVsZCBwcmVwcm9jZXNzIGluZm9ybWF0aW9uIGludG8gYXN0LlxuICogQHBhcmFtIHtvYmplY3R9IHBhcmFtIC0gRmllbGQgaW5mb3JtYXRpb25cbiAqIEBwYXJhbSB7b2JqZWN0fSBjb21waWxlQ29udGV4dCAtIENvbXBpbGF0aW9uIGNvbnRleHRcbiAqIEByZXR1cm5zIHtzdHJpbmd9XG4gKi9cbmZ1bmN0aW9uIGNvbXBpbGVGaWVsZChwYXJhbU5hbWUsIHBhcmFtLCBjb21waWxlQ29udGV4dCkge1xuICAgIC8vIDEuIHJlZmVyZW5jZSB0byB0aGUgbGF0ZXN0IG9iamVjdCB0aGF0IGlzIHBhc3NlZCBxdWFsaWZpZXIgY2hlY2tzXG4gICAgLy8gMi4gaWYgbW9kaWZpZXJzIGV4aXN0LCB3cmFwIHRoZSByZWYgaW50byBhIHBpcGVkIHZhbHVlXG4gICAgLy8gMy4gcHJvY2VzcyB0aGUgcmVmIChvciBwaXBlZCByZWYpIGFuZCBtYXJrIGFzIGVuZFxuICAgIC8vIDQuIGJ1aWxkIGRlcGVuZGVuY2llczogbGF0ZXN0LmZpZWxkIC0+IC4uLiAtPiBmaWVsZDpyZWFkeSBcbiAgICBsZXQgdG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBwYXJhbU5hbWUpO1xuICAgIGxldCBjb250ZXh0TmFtZSA9ICdsYXRlc3QuJyArIHBhcmFtTmFtZTtcbiAgICAvL2NvbXBpbGVDb250ZXh0LmFzdE1hcFt0b3BvSWRdID0gSnNMYW5nLmFzdFZhclJlZihjb250ZXh0TmFtZSwgdHJ1ZSk7XG5cbiAgICBsZXQgdmFsdWUgPSB3cmFwUGFyYW1SZWZlcmVuY2UoY29udGV4dE5hbWUsIHBhcmFtKTsgICAgXG4gICAgbGV0IGVuZFRvcG9JZCA9IGNvbXBpbGVDb25jcmV0ZVZhbHVlRXhwcmVzc2lvbih0b3BvSWQsIHZhbHVlLCBjb21waWxlQ29udGV4dCk7XG5cbiAgICBsZXQgcmVhZHlUb3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIHRvcG9JZCArICc6cmVhZHknKTtcbiAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIGVuZFRvcG9JZCwgcmVhZHlUb3BvSWQpO1xuXG4gICAgcmV0dXJuIHJlYWR5VG9wb0lkO1xufVxuXG5mdW5jdGlvbiB3cmFwUGFyYW1SZWZlcmVuY2UobmFtZSwgdmFsdWUpIHtcbiAgICBsZXQgcmVmID0gT2JqZWN0LmFzc2lnbih7IG9vbFR5cGU6ICdPYmplY3RSZWZlcmVuY2UnLCBuYW1lOiBuYW1lIH0pO1xuICAgIFxuICAgIGlmICghXy5pc0VtcHR5KHZhbHVlLm1vZGlmaWVycykpIHtcbiAgICAgICAgcmV0dXJuIHsgb29sVHlwZTogJ1BpcGVkVmFsdWUnLCB2YWx1ZTogcmVmLCBtb2RpZmllcnM6IHZhbHVlLm1vZGlmaWVycyB9O1xuICAgIH1cbiAgICBcbiAgICByZXR1cm4gcmVmO1xufVxuXG5mdW5jdGlvbiBoYXNNb2RlbEZpZWxkKG9wZXJhbmQsIGNvbXBpbGVDb250ZXh0KSB7XG4gICAgaWYgKF8uaXNQbGFpbk9iamVjdChvcGVyYW5kKSAmJiBvcGVyYW5kLm9vbFR5cGUgPT09ICdPYmplY3RSZWZlcmVuY2UnKSB7XG4gICAgICAgIGxldCBbIGJhc2VWYXIsIC4uLnJlc3QgXSA9IG9wZXJhbmQubmFtZS5zcGxpdCgnLicpO1xuXG4gICAgICAgIHJldHVybiBjb21waWxlQ29udGV4dC52YXJpYWJsZXNbYmFzZVZhcl0gJiYgY29tcGlsZUNvbnRleHQudmFyaWFibGVzW2Jhc2VWYXJdLm9uZ29pbmcgJiYgcmVzdC5sZW5ndGggPiAwOyAgICAgICAgXG4gICAgfVxuXG4gICAgcmV0dXJuIGZhbHNlOyAgICBcbn1cblxuLyoqXG4gKiBUcmFuc2xhdGUgYSB0aGVuIGNsYXVzZSBmcm9tIG9vbCBpbnRvIGFzdCBpbiByZXR1cm4gYmxvY2suXG4gKiBAcGFyYW0ge3N0cmluZ30gc3RhcnRJZFxuICogQHBhcmFtIHtzdHJpbmd9IGVuZElkXG4gKiBAcGFyYW0gdGhlblxuICogQHBhcmFtIGNvbXBpbGVDb250ZXh0XG4gKiBAcmV0dXJucyB7b2JqZWN0fSBBU1Qgb2JqZWN0XG4gKi9cbmZ1bmN0aW9uIHRyYW5zbGF0ZVJldHVyblRoZW5Bc3Qoc3RhcnRJZCwgZW5kSWQsIHRoZW4sIGNvbXBpbGVDb250ZXh0KSB7XG4gICAgaWYgKF8uaXNQbGFpbk9iamVjdCh0aGVuKSkge1xuICAgICAgICBpZiAodGhlbi5vb2xUeXBlID09PSAnVGhyb3dFeHByZXNzaW9uJykge1xuICAgICAgICAgICAgbGV0IGFyZ3M7XG4gICAgICAgICAgICBpZiAodGhlbi5hcmdzKSB7XG4gICAgICAgICAgICAgICAgYXJncyA9IHRyYW5zbGF0ZUFyZ3Moc3RhcnRJZCwgdGhlbi5hcmdzLCBjb21waWxlQ29udGV4dCk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGFyZ3MgPSBbXTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiBKc0xhbmcuYXN0VGhyb3codGhlbi5lcnJvclR5cGUgfHwgZGVmYXVsdEVycm9yLCB0aGVuLm1lc3NhZ2UgfHwgYXJncyk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAodGhlbi5vb2xUeXBlID09PSAnUmV0dXJuRXhwcmVzc2lvbicpIHtcbiAgICAgICAgICAgIHJldHVybiB0cmFuc2xhdGVSZXR1cm5WYWx1ZUFzdChzdGFydElkLCBlbmRJZCwgdGhlbi52YWx1ZSwgY29tcGlsZUNvbnRleHQpO1xuICAgICAgICB9ICAgICAgICBcbiAgICB9XG5cbiAgICAvL3RoZW4gZXhwcmVzc2lvbiBpcyBhbiBvb2xvbmcgY29uY3JldGUgdmFsdWUgICAgXG4gICAgaWYgKF8uaXNBcnJheSh0aGVuKSB8fCBfLmlzUGxhaW5PYmplY3QodGhlbikpIHtcbiAgICAgICAgbGV0IHZhbHVlRW5kSWQgPSBjb21waWxlQ29uY3JldGVWYWx1ZUV4cHJlc3Npb24oc3RhcnRJZCwgdGhlbiwgY29tcGlsZUNvbnRleHQpOyAgICBcbiAgICAgICAgdGhlbiA9IGNvbXBpbGVDb250ZXh0LmFzdE1hcFt2YWx1ZUVuZElkXTsgXG4gICAgfSAgIFxuXG4gICAgcmV0dXJuIEpzTGFuZy5hc3RSZXR1cm4odGhlbik7XG59XG5cbi8qKlxuICogVHJhbnNsYXRlIGEgdGhlbiBjbGF1c2UgZnJvbSBvb2wgaW50byBhc3RcbiAqIEBwYXJhbSB7c3RyaW5nfSBzdGFydElkXG4gKiBAcGFyYW0ge3N0cmluZ30gZW5kSWRcbiAqIEBwYXJhbSB0aGVuXG4gKiBAcGFyYW0gY29tcGlsZUNvbnRleHRcbiAqIEBwYXJhbSBhc3NpZ25Ub1xuICogQHJldHVybnMge29iamVjdH0gQVNUIG9iamVjdFxuICovXG5mdW5jdGlvbiB0cmFuc2xhdGVUaGVuQXN0KHN0YXJ0SWQsIGVuZElkLCB0aGVuLCBjb21waWxlQ29udGV4dCwgYXNzaWduVG8pIHtcbiAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHRoZW4pKSB7XG4gICAgICAgIGlmICh0aGVuLm9vbFR5cGUgPT09ICdUaHJvd0V4cHJlc3Npb24nKSB7XG4gICAgICAgICAgICBsZXQgYXJncztcbiAgICAgICAgICAgIGlmICh0aGVuLmFyZ3MpIHtcbiAgICAgICAgICAgICAgICBhcmdzID0gdHJhbnNsYXRlQXJncyhzdGFydElkLCB0aGVuLmFyZ3MsIGNvbXBpbGVDb250ZXh0KTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgYXJncyA9IFtdO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIEpzTGFuZy5hc3RUaHJvdyh0aGVuLmVycm9yVHlwZSB8fCBkZWZhdWx0RXJyb3IsIHRoZW4ubWVzc2FnZSB8fCBhcmdzKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICh0aGVuLm9vbFR5cGUgPT09ICdMb2dpY2FsRXhwcmVzc2lvbicpIHtcbiAgICAgICAgICAgIC8qXG4gICAgICAgICAgICBzd2l0Y2ggKHRoZW4ub3BlcmF0b3IpIHtcbiAgICAgICAgICAgICAgICBjYXNlICdhbmQnOlxuICAgICAgICAgICAgICAgICAgICBvcCA9ICcmJic7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgY2FzZSAnb3InOlxuICAgICAgICAgICAgICAgICAgICBvcCA9ICd8fCc7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbnN1cHBvcnRlZCB0ZXN0IG9wZXJhdG9yOiAnICsgdGVzdC5vcGVyYXRvcik7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICAqL1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHRoZW4ub29sVHlwZSA9PT0gJ0JpbmFyeUV4cHJlc3Npb24nKSB7XG4gICAgICAgICAgICBpZiAoIWhhc01vZGVsRmllbGQodGhlbi5sZWZ0LCBjb21waWxlQ29udGV4dCkpIHsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdJbnZhbGlkIHF1ZXJ5IGNvbmRpdGlvbjogdGhlIGxlZnQgb3BlcmFuZCBuZWVkIHRvIGJlIGFuIGVudGl0eSBmaWVsZC4nKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGhhc01vZGVsRmllbGQodGhlbi5yaWdodCwgY29tcGlsZUNvbnRleHQpKSB7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignSW52YWxpZCBxdWVyeSBjb25kaXRpb246IHRoZSByaWdodCBvcGVyYW5kIHNob3VsZCBub3QgYmUgYW4gZW50aXR5IGZpZWxkLiBVc2UgZGF0YXNldCBpbnN0ZWFkIGlmIGpvaW5pbmcgaXMgcmVxdWlyZWQuJyk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCBjb25kaXRpb24gPSB7fTtcbiAgICAgICAgICAgIGxldCBzdGFydFJpZ2h0SWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIHN0YXJ0SWQgKyAnJGJpbk9wOnJpZ2h0Jyk7XG4gICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIHN0YXJ0SWQsIHN0YXJ0UmlnaHRJZCk7XG5cbiAgICAgICAgICAgIGxldCBsYXN0UmlnaHRJZCA9IGNvbXBpbGVDb25jcmV0ZVZhbHVlRXhwcmVzc2lvbihzdGFydFJpZ2h0SWQsIHRoZW4ucmlnaHQsIGNvbXBpbGVDb250ZXh0KTtcbiAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgbGFzdFJpZ2h0SWQsIGVuZElkKTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKHRoZW4ub3BlcmF0b3IgPT09ICc9PScpIHtcbiAgICAgICAgICAgICAgICBjb25kaXRpb25bdGhlbi5sZWZ0Lm5hbWUuc3BsaXQoJy4nLCAyKVsxXV0gPSBjb21waWxlQ29udGV4dC5hc3RNYXBbbGFzdFJpZ2h0SWRdO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBjb25kaXRpb25bdGhlbi5sZWZ0Lm5hbWUuc3BsaXQoJy4nLCAyKVsxXV0gPSB7IFtPUEVSQVRPUl9UT0tFTltvcF1dOiBjb21waWxlQ29udGV4dC5hc3RNYXBbbGFzdFJpZ2h0SWRdIH07XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiBKc0xhbmcuYXN0QXNzaWduKGFzc2lnblRvLCBKc0xhbmcuYXN0VmFsdWUoY29uZGl0aW9uKSk7ICAgICAgICAgICBcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICh0aGVuLm9vbFR5cGUgPT09ICdVbmFyeUV4cHJlc3Npb24nKSB7XG4gICAgICAgICAgICBcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8vdGhlbiBleHByZXNzaW9uIGlzIGFuIG9vbG9uZyBjb25jcmV0ZSB2YWx1ZSAgICBcbiAgICBpZiAoXy5pc0FycmF5KHRoZW4pIHx8IF8uaXNQbGFpbk9iamVjdCh0aGVuKSkge1xuICAgICAgICBsZXQgdmFsdWVFbmRJZCA9IGNvbXBpbGVDb25jcmV0ZVZhbHVlRXhwcmVzc2lvbihzdGFydElkLCB0aGVuLCBjb21waWxlQ29udGV4dCk7ICAgIFxuICAgICAgICB0aGVuID0gY29tcGlsZUNvbnRleHQuYXN0TWFwW3ZhbHVlRW5kSWRdOyBcbiAgICB9ICAgXG5cbiAgICByZXR1cm4gSnNMYW5nLmFzdEFzc2lnbihhc3NpZ25UbywgdGhlbik7XG59XG5cbi8qKlxuICogVHJhbnNsYXRlIGEgcmV0dXJuIGNsYXVzZSBmcm9tIG9vbCBpbnRvIGFzdFxuICogQHBhcmFtIHtzdHJpbmd9IHN0YXJ0VG9wb0lkIC0gVGhlIHRvcG8gaWQgb2YgdGhlIHN0YXJ0aW5nIHN0YXRlIG9mIHJldHVybiBjbGF1c2VcbiAqIEBwYXJhbSB7c3RyaW5nfSBlbmRUb3BvSWQgLSBUaGUgdG9wbyBpZCBvZiB0aGUgZW5kaW5nIHN0YXRlIG9mIHJldHVybiBjbGF1c2VcbiAqIEBwYXJhbSB2YWx1ZVxuICogQHBhcmFtIGNvbXBpbGVDb250ZXh0XG4gKiBAcmV0dXJucyB7b2JqZWN0fSBBU1Qgb2JqZWN0XG4gKi9cbmZ1bmN0aW9uIHRyYW5zbGF0ZVJldHVyblZhbHVlQXN0KHN0YXJ0VG9wb0lkLCBlbmRUb3BvSWQsIHZhbHVlLCBjb21waWxlQ29udGV4dCkge1xuICAgIGxldCB2YWx1ZVRvcG9JZCA9IGNvbXBpbGVDb25jcmV0ZVZhbHVlRXhwcmVzc2lvbihzdGFydFRvcG9JZCwgdmFsdWUsIGNvbXBpbGVDb250ZXh0KTtcbiAgICBpZiAodmFsdWVUb3BvSWQgIT09IHN0YXJ0VG9wb0lkKSB7XG4gICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgdmFsdWVUb3BvSWQsIGVuZFRvcG9JZCk7XG4gICAgfVxuXG4gICAgcmV0dXJuIEpzTGFuZy5hc3RSZXR1cm4oZ2V0Q29kZVJlcHJlc2VudGF0aW9uT2YodmFsdWVUb3BvSWQsIGNvbXBpbGVDb250ZXh0KSk7XG59XG5cbi8qKlxuICogQ29tcGlsZSBhIHJldHVybiBjbGF1c2UgZnJvbSBvb2wgaW50byBhc3RcbiAqIEBwYXJhbSB7c3RyaW5nfSBzdGFydFRvcG9JZCAtIFRoZSB0b3BvIGlkIG9mIHRoZSBzdGFydGluZyBwcm9jZXNzIHRvIHRoZSB0YXJnZXQgdmFsdWUgZXhwcmVzc2lvblxuICogQHBhcmFtIHZhbHVlXG4gKiBAcGFyYW0gY29tcGlsZUNvbnRleHRcbiAqIEByZXR1cm5zIHtvYmplY3R9IEFTVCBvYmplY3RcbiAqL1xuZnVuY3Rpb24gY29tcGlsZVJldHVybihzdGFydFRvcG9JZCwgdmFsdWUsIGNvbXBpbGVDb250ZXh0KSB7XG4gICAgbGV0IGVuZFRvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgJyRyZXR1cm4nKTtcbiAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIHN0YXJ0VG9wb0lkLCBlbmRUb3BvSWQpO1xuXG4gICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW2VuZFRvcG9JZF0gPSB0cmFuc2xhdGVSZXR1cm5WYWx1ZUFzdChzdGFydFRvcG9JZCwgZW5kVG9wb0lkLCB2YWx1ZSwgY29tcGlsZUNvbnRleHQpO1xuXG4gICAgYWRkQ29kZUJsb2NrKGNvbXBpbGVDb250ZXh0LCBlbmRUb3BvSWQsIHtcbiAgICAgICAgdHlwZTogQVNUX0JMS19WSUVXX1JFVFVSTlxuICAgIH0pO1xuXG4gICAgcmV0dXJuIGVuZFRvcG9JZDtcbn1cblxuLyoqXG4gKiBDb21waWxlIGEgZmluZCBvbmUgb3BlcmF0aW9uIGZyb20gb29sIGludG8gYXN0XG4gKiBAcGFyYW0ge2ludH0gaW5kZXhcbiAqIEBwYXJhbSB7b2JqZWN0fSBvcGVyYXRpb24gLSBPb2wgbm9kZVxuICogQHBhcmFtIHtvYmplY3R9IGNvbXBpbGVDb250ZXh0IC1cbiAqIEBwYXJhbSB7c3RyaW5nfSBkZXBlbmRlbmN5XG4gKiBAcmV0dXJucyB7c3RyaW5nfSBsYXN0IHRvcG9JZFxuICovXG5mdW5jdGlvbiBjb21waWxlRmluZE9uZShpbmRleCwgb3BlcmF0aW9uLCBjb21waWxlQ29udGV4dCwgZGVwZW5kZW5jeSkge1xuICAgIHByZTogZGVwZW5kZW5jeTtcblxuICAgIGxldCBlbmRUb3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsICdvcCQnICsgaW5kZXgudG9TdHJpbmcoKSk7XG4gICAgbGV0IGNvbmRpdGlvblZhck5hbWUgPSBlbmRUb3BvSWQgKyAnJGNvbmRpdGlvbic7XG5cbiAgICBsZXQgYXN0ID0gW1xuICAgICAgICBKc0xhbmcuYXN0VmFyRGVjbGFyZShjb25kaXRpb25WYXJOYW1lKVxuICAgIF07XG5cbiAgICBhc3NlcnQ6IG9wZXJhdGlvbi5jb25kaXRpb247XG5cbiAgICBjb21waWxlQ29udGV4dC52YXJpYWJsZXNbb3BlcmF0aW9uLm1vZGVsXSA9IHsgdHlwZTogJ2VudGl0eScsIHNvdXJjZTogJ2ZpbmRPbmUnLCBvbmdvaW5nOiB0cnVlIH07XG5cbiAgICBpZiAob3BlcmF0aW9uLmNvbmRpdGlvbi5vb2xUeXBlKSB7XG4gICAgICAgIC8vc3BlY2lhbCBjb25kaXRpb25cblxuICAgICAgICBpZiAob3BlcmF0aW9uLmNvbmRpdGlvbi5vb2xUeXBlID09PSAnY2FzZXMnKSB7XG4gICAgICAgICAgICBsZXQgdG9wb0lkUHJlZml4ID0gZW5kVG9wb0lkICsgJyRjYXNlcyc7XG4gICAgICAgICAgICBsZXQgbGFzdFN0YXRlbWVudDtcblxuICAgICAgICAgICAgaWYgKG9wZXJhdGlvbi5jb25kaXRpb24uZWxzZSkge1xuICAgICAgICAgICAgICAgIGxldCBlbHNlU3RhcnQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIHRvcG9JZFByZWZpeCArICc6ZWxzZScpO1xuICAgICAgICAgICAgICAgIGxldCBlbHNlRW5kID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCB0b3BvSWRQcmVmaXggKyAnOmVuZCcpO1xuICAgICAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgZWxzZVN0YXJ0LCBlbHNlRW5kKTtcbiAgICAgICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIGVsc2VFbmQsIGVuZFRvcG9JZCk7XG5cbiAgICAgICAgICAgICAgICBsYXN0U3RhdGVtZW50ID0gdHJhbnNsYXRlVGhlbkFzdChlbHNlU3RhcnQsIGVsc2VFbmQsIG9wZXJhdGlvbi5jb25kaXRpb24uZWxzZSwgY29tcGlsZUNvbnRleHQsIGNvbmRpdGlvblZhck5hbWUpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBsYXN0U3RhdGVtZW50ID0gSnNMYW5nLmFzdFRocm93KCdTZXJ2ZXJFcnJvcicsICdVbmV4cGVjdGVkIHN0YXRlLicpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoXy5pc0VtcHR5KG9wZXJhdGlvbi5jb25kaXRpb24uaXRlbXMpKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdNaXNzaW5nIGNhc2UgaXRlbXMnKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgXy5yZXZlcnNlKG9wZXJhdGlvbi5jb25kaXRpb24uaXRlbXMpLmZvckVhY2goKGl0ZW0sIGkpID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoaXRlbS5vb2xUeXBlICE9PSAnQ29uZGl0aW9uYWxTdGF0ZW1lbnQnKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignSW52YWxpZCBjYXNlIGl0ZW0uJyk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaSA9IG9wZXJhdGlvbi5jb25kaXRpb24uaXRlbXMubGVuZ3RoIC0gaSAtIDE7XG5cbiAgICAgICAgICAgICAgICBsZXQgY2FzZVByZWZpeCA9IHRvcG9JZFByZWZpeCArICdbJyArIGkudG9TdHJpbmcoKSArICddJztcbiAgICAgICAgICAgICAgICBsZXQgY2FzZVRvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgY2FzZVByZWZpeCk7XG4gICAgICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBkZXBlbmRlbmN5LCBjYXNlVG9wb0lkKTtcblxuICAgICAgICAgICAgICAgIGxldCBjYXNlUmVzdWx0VmFyTmFtZSA9ICckJyArIHRvcG9JZFByZWZpeCArICdfJyArIGkudG9TdHJpbmcoKTtcblxuICAgICAgICAgICAgICAgIGxldCBsYXN0VG9wb0lkID0gY29tcGlsZUNvbmRpdGlvbmFsRXhwcmVzc2lvbihpdGVtLnRlc3QsIGNvbXBpbGVDb250ZXh0LCBjYXNlVG9wb0lkKTtcbiAgICAgICAgICAgICAgICBsZXQgYXN0Q2FzZVR0ZW0gPSBnZXRDb2RlUmVwcmVzZW50YXRpb25PZihsYXN0VG9wb0lkLCBjb21waWxlQ29udGV4dCk7XG5cbiAgICAgICAgICAgICAgICBhc3NlcnQ6ICFBcnJheS5pc0FycmF5KGFzdENhc2VUdGVtKSwgJ0ludmFsaWQgY2FzZSBpdGVtIGFzdC4nO1xuXG4gICAgICAgICAgICAgICAgYXN0Q2FzZVR0ZW0gPSBKc0xhbmcuYXN0VmFyRGVjbGFyZShjYXNlUmVzdWx0VmFyTmFtZSwgYXN0Q2FzZVR0ZW0sIHRydWUsIGZhbHNlLCBgQ29uZGl0aW9uICR7aX0gZm9yIGZpbmQgb25lICR7b3BlcmF0aW9uLm1vZGVsfWApO1xuXG4gICAgICAgICAgICAgICAgbGV0IGlmU3RhcnQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIGNhc2VQcmVmaXggKyAnOnRoZW4nKTtcbiAgICAgICAgICAgICAgICBsZXQgaWZFbmQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIGNhc2VQcmVmaXggKyAnOmVuZCcpO1xuICAgICAgICAgICAgICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgbGFzdFRvcG9JZCwgaWZTdGFydCk7XG4gICAgICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBpZlN0YXJ0LCBpZkVuZCk7XG5cbiAgICAgICAgICAgICAgICBsYXN0U3RhdGVtZW50ID0gW1xuICAgICAgICAgICAgICAgICAgICBhc3RDYXNlVHRlbSxcbiAgICAgICAgICAgICAgICAgICAgSnNMYW5nLmFzdElmKEpzTGFuZy5hc3RWYXJSZWYoY2FzZVJlc3VsdFZhck5hbWUpLCBKc0xhbmcuYXN0QmxvY2sodHJhbnNsYXRlVGhlbkFzdChpZlN0YXJ0LCBpZkVuZCwgaXRlbS50aGVuLCBjb21waWxlQ29udGV4dCwgY29uZGl0aW9uVmFyTmFtZSkpLCBsYXN0U3RhdGVtZW50KVxuICAgICAgICAgICAgICAgIF07XG4gICAgICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBpZkVuZCwgZW5kVG9wb0lkKTtcbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICBhc3QgPSBhc3QuY29uY2F0KF8uY2FzdEFycmF5KGxhc3RTdGF0ZW1lbnQpKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcigndG9kbycpO1xuICAgICAgICB9XG5cblxuICAgIH0gZWxzZSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcigndG9kbycpO1xuICAgIH1cblxuICAgIGFzdC5wdXNoKFxuICAgICAgICBKc0xhbmcuYXN0VmFyRGVjbGFyZShvcGVyYXRpb24ubW9kZWwsIEpzTGFuZy5hc3RBd2FpdChgdGhpcy5maW5kT25lX2AsIEpzTGFuZy5hc3RWYXJSZWYoY29uZGl0aW9uVmFyTmFtZSkpKVxuICAgICk7XG5cbiAgICBkZWxldGUgY29tcGlsZUNvbnRleHQudmFyaWFibGVzW29wZXJhdGlvbi5tb2RlbF0ub25nb2luZztcblxuICAgIGxldCBtb2RlbFRvcG9JZCA9IGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgb3BlcmF0aW9uLm1vZGVsKTtcbiAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIGVuZFRvcG9JZCwgbW9kZWxUb3BvSWQpO1xuICAgIGNvbXBpbGVDb250ZXh0LmFzdE1hcFtlbmRUb3BvSWRdID0gYXN0O1xuICAgIHJldHVybiBlbmRUb3BvSWQ7XG59XG5cbmZ1bmN0aW9uIGNvbXBpbGVEYk9wZXJhdGlvbihpbmRleCwgb3BlcmF0aW9uLCBjb21waWxlQ29udGV4dCwgZGVwZW5kZW5jeSkge1xuICAgIGxldCBsYXN0VG9wb0lkO1xuXG4gICAgc3dpdGNoIChvcGVyYXRpb24ub29sVHlwZSkge1xuICAgICAgICBjYXNlICdGaW5kT25lU3RhdGVtZW50JzpcbiAgICAgICAgICAgIGxhc3RUb3BvSWQgPSBjb21waWxlRmluZE9uZShpbmRleCwgb3BlcmF0aW9uLCBjb21waWxlQ29udGV4dCwgZGVwZW5kZW5jeSk7XG4gICAgICAgICAgICBicmVhaztcblxuICAgICAgICBjYXNlICdmaW5kJzpcbiAgICAgICAgICAgIC8vcHJlcGFyZURiQ29ubmVjdGlvbihjb21waWxlQ29udGV4dCk7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ3RiaScpO1xuICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgY2FzZSAndXBkYXRlJzpcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcigndGJpJyk7XG4gICAgICAgICAgICAvL3ByZXBhcmVEYkNvbm5lY3Rpb24oY29tcGlsZUNvbnRleHQpO1xuICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgY2FzZSAnY3JlYXRlJzpcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcigndGJpJyk7XG4gICAgICAgICAgICAvL3ByZXBhcmVEYkNvbm5lY3Rpb24oY29tcGlsZUNvbnRleHQpO1xuICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgY2FzZSAnZGVsZXRlJzpcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcigndGJpJyk7XG4gICAgICAgICAgICAvL3ByZXBhcmVEYkNvbm5lY3Rpb24oY29tcGlsZUNvbnRleHQpO1xuICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgY2FzZSAnRG9TdGF0ZW1lbnQnOlxuICAgICAgICAgICAgbGV0IGRvQmxvY2sgPSBvcGVyYXRpb24uZG87XG4gICAgICAgICAgICBsYXN0VG9wb0lkID0gY29tcGlsZURvU3RhdGVtZW50KGluZGV4LCBkb0Jsb2NrLCBjb21waWxlQ29udGV4dCwgZGVwZW5kZW5jeSk7XG4gICAgICAgICAgICBicmVhaztcblxuICAgICAgICBjYXNlICdhc3NpZ25tZW50JzpcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcigndGJpJyk7XG4gICAgICAgICAgICBicmVhaztcblxuICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbnN1cHBvcnRlZCBvcGVyYXRpb24gdHlwZTogJyArIG9wZXJhdGlvbi50eXBlKTtcbiAgICB9XG5cbiAgICBhZGRDb2RlQmxvY2soY29tcGlsZUNvbnRleHQsIGxhc3RUb3BvSWQsIHtcbiAgICAgICAgdHlwZTogQVNUX0JMS19JTlRFUkZBQ0VfT1BFUkFUSU9OXG4gICAgfSk7XG5cbiAgICByZXR1cm4gbGFzdFRvcG9JZDtcbn1cblxuZnVuY3Rpb24gY29tcGlsZURvU3RhdGVtZW50KGluZGV4LCBvcGVyYXRpb24sIGNvbXBpbGVDb250ZXh0LCBkZXBlbmRlbmN5KSB7XG4gICAgICAgIFxufVxuXG4vKipcbiAqIENvbXBpbGUgZXhjZXB0aW9uYWwgcmV0dXJuIFxuICogQHBhcmFtIHtvYmplY3R9IG9vbE5vZGVcbiAqIEBwYXJhbSB7b2JqZWN0fSBjb21waWxlQ29udGV4dFxuICogQHBhcmFtIHtzdHJpbmd9IFtkZXBlbmRlbmN5XVxuICogQHJldHVybnMge3N0cmluZ30gbGFzdCB0b3BvSWRcbiAqL1xuZnVuY3Rpb24gY29tcGlsZUV4Y2VwdGlvbmFsUmV0dXJuKG9vbE5vZGUsIGNvbXBpbGVDb250ZXh0LCBkZXBlbmRlbmN5KSB7XG4gICAgcHJlOiAoXy5pc1BsYWluT2JqZWN0KG9vbE5vZGUpICYmIG9vbE5vZGUub29sVHlwZSA9PT0gJ1JldHVybkV4cHJlc3Npb24nKTtcblxuICAgIGxldCBlbmRUb3BvSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsICckcmV0dXJuJyksIGxhc3RFeGNlcHRpb25JZCA9IGRlcGVuZGVuY3k7XG5cbiAgICBpZiAoIV8uaXNFbXB0eShvb2xOb2RlLmV4Y2VwdGlvbnMpKSB7XG4gICAgICAgIG9vbE5vZGUuZXhjZXB0aW9ucy5mb3JFYWNoKChpdGVtLCBpKSA9PiB7XG4gICAgICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGl0ZW0pKSB7XG4gICAgICAgICAgICAgICAgaWYgKGl0ZW0ub29sVHlwZSAhPT0gJ0NvbmRpdGlvbmFsU3RhdGVtZW50Jykge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1Vuc3VwcG9ydGVkIGV4Y2VwdGlvbmFsIHR5cGU6ICcgKyBpdGVtLm9vbFR5cGUpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGxldCBleGNlcHRpb25TdGFydElkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBlbmRUb3BvSWQgKyAnOmV4Y2VwdFsnICsgaS50b1N0cmluZygpICsgJ10nKTtcbiAgICAgICAgICAgICAgICBsZXQgZXhjZXB0aW9uRW5kSWQgPSBjcmVhdGVUb3BvSWQoY29tcGlsZUNvbnRleHQsIGVuZFRvcG9JZCArICc6ZXhjZXB0WycgKyBpLnRvU3RyaW5nKCkgKyAnXTpkb25lJyk7XG4gICAgICAgICAgICAgICAgaWYgKGxhc3RFeGNlcHRpb25JZCkge1xuICAgICAgICAgICAgICAgICAgICBkZXBlbmRzT24oY29tcGlsZUNvbnRleHQsIGxhc3RFeGNlcHRpb25JZCwgZXhjZXB0aW9uU3RhcnRJZCk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgbGV0IGxhc3RUb3BvSWQgPSBjb21waWxlQ29uZGl0aW9uYWxFeHByZXNzaW9uKGl0ZW0udGVzdCwgY29tcGlsZUNvbnRleHQsIGV4Y2VwdGlvblN0YXJ0SWQpO1xuXG4gICAgICAgICAgICAgICAgbGV0IHRoZW5TdGFydElkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCBleGNlcHRpb25TdGFydElkICsgJzp0aGVuJyk7XG4gICAgICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBsYXN0VG9wb0lkLCB0aGVuU3RhcnRJZCk7XG4gICAgICAgICAgICAgICAgZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCB0aGVuU3RhcnRJZCwgZXhjZXB0aW9uRW5kSWQpO1xuXG4gICAgICAgICAgICAgICAgY29tcGlsZUNvbnRleHQuYXN0TWFwW2V4Y2VwdGlvbkVuZElkXSA9IEpzTGFuZy5hc3RJZihcbiAgICAgICAgICAgICAgICAgICAgZ2V0Q29kZVJlcHJlc2VudGF0aW9uT2YobGFzdFRvcG9JZCwgY29tcGlsZUNvbnRleHQpLFxuICAgICAgICAgICAgICAgICAgICBKc0xhbmcuYXN0QmxvY2sodHJhbnNsYXRlUmV0dXJuVGhlbkFzdChcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoZW5TdGFydElkLFxuICAgICAgICAgICAgICAgICAgICAgICAgZXhjZXB0aW9uRW5kSWQsXG4gICAgICAgICAgICAgICAgICAgICAgICBpdGVtLnRoZW4sIGNvbXBpbGVDb250ZXh0KSksXG4gICAgICAgICAgICAgICAgICAgIG51bGwsXG4gICAgICAgICAgICAgICAgICAgIGBSZXR1cm4gb24gZXhjZXB0aW9uICMke2l9YFxuICAgICAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgICAgICBhZGRDb2RlQmxvY2soY29tcGlsZUNvbnRleHQsIGV4Y2VwdGlvbkVuZElkLCB7XG4gICAgICAgICAgICAgICAgICAgIHR5cGU6IEFTVF9CTEtfRVhDRVBUSU9OX0lURU1cbiAgICAgICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgICAgIGxhc3RFeGNlcHRpb25JZCA9IGV4Y2VwdGlvbkVuZElkO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1VuZXhwZWN0ZWQuJyk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgbGFzdEV4Y2VwdGlvbklkLCBlbmRUb3BvSWQpO1xuXG4gICAgbGV0IHJldHVyblN0YXJ0VG9wb0lkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCAnJHJldHVybjp2YWx1ZScpO1xuICAgIGRlcGVuZHNPbihjb21waWxlQ29udGV4dCwgcmV0dXJuU3RhcnRUb3BvSWQsIGVuZFRvcG9JZCk7XG5cbiAgICBjb21waWxlQ29udGV4dC5hc3RNYXBbZW5kVG9wb0lkXSA9IHRyYW5zbGF0ZVJldHVyblZhbHVlQXN0KHJldHVyblN0YXJ0VG9wb0lkLCBlbmRUb3BvSWQsIG9vbE5vZGUudmFsdWUsIGNvbXBpbGVDb250ZXh0KTtcblxuICAgIGFkZENvZGVCbG9jayhjb21waWxlQ29udGV4dCwgZW5kVG9wb0lkLCB7XG4gICAgICAgIHR5cGU6IEFTVF9CTEtfSU5URVJGQUNFX1JFVFVSTlxuICAgIH0pO1xuICAgIFxuICAgIHJldHVybiBlbmRUb3BvSWQ7XG59XG5cbmZ1bmN0aW9uIGNyZWF0ZVRvcG9JZChjb21waWxlQ29udGV4dCwgbmFtZSkge1xuICAgIGlmIChjb21waWxlQ29udGV4dC50b3BvTm9kZXMuaGFzKG5hbWUpKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgVG9wbyBpZCBcIiR7bmFtZX1cIiBhbHJlYWR5IGNyZWF0ZWQuYCk7XG4gICAgfVxuXG4gICAgYXNzZXJ0OiAhY29tcGlsZUNvbnRleHQudG9wb1NvcnQuaGFzRGVwZW5kZW5jeShuYW1lKSwgJ0FscmVhZHkgaW4gdG9wb1NvcnQhJztcblxuICAgIGNvbXBpbGVDb250ZXh0LnRvcG9Ob2Rlcy5hZGQobmFtZSk7XG5cbiAgICByZXR1cm4gbmFtZTtcbn1cblxuZnVuY3Rpb24gZGVwZW5kc09uKGNvbXBpbGVDb250ZXh0LCBwcmV2aW91c09wLCBjdXJyZW50T3ApIHtcbiAgICBwcmU6IHByZXZpb3VzT3AgIT09IGN1cnJlbnRPcCwgJ1NlbGYgZGVwZW5kaW5nJztcblxuICAgIGNvbXBpbGVDb250ZXh0LmxvZ2dlci5kZWJ1ZyhjdXJyZW50T3AgKyAnIFxceDFiWzMzbWRlcGVuZHMgb25cXHgxYlswbSAnICsgcHJldmlvdXNPcCk7XG5cbiAgICBpZiAoIWNvbXBpbGVDb250ZXh0LnRvcG9Ob2Rlcy5oYXMoY3VycmVudE9wKSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFRvcG8gaWQgXCIke2N1cnJlbnRPcH1cIiBub3QgY3JlYXRlZC5gKTtcbiAgICB9XG5cbiAgICBjb21waWxlQ29udGV4dC50b3BvU29ydC5hZGQocHJldmlvdXNPcCwgY3VycmVudE9wKTtcbn1cblxuZnVuY3Rpb24gYWRkQ29kZUJsb2NrKGNvbXBpbGVDb250ZXh0LCB0b3BvSWQsIGJsb2NrTWV0YSkge1xuICAgIGlmICghKHRvcG9JZCBpbiBjb21waWxlQ29udGV4dC5hc3RNYXApKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgQVNUIG5vdCBmb3VuZCBmb3IgYmxvY2sgd2l0aCB0b3BvSWQ6ICR7dG9wb0lkfWApO1xuICAgIH1cblxuICAgIGNvbXBpbGVDb250ZXh0Lm1hcE9mVG9rZW5Ub01ldGEuc2V0KHRvcG9JZCwgYmxvY2tNZXRhKTtcblxuICAgIGNvbXBpbGVDb250ZXh0LmxvZ2dlci52ZXJib3NlKGBBZGRpbmcgJHtibG9ja01ldGEudHlwZX0gXCIke3RvcG9JZH1cIiBpbnRvIHNvdXJjZSBjb2RlLmApO1xuICAgIC8vY29tcGlsZUNvbnRleHQubG9nZ2VyLmRlYnVnKCdBU1Q6XFxuJyArIEpTT04uc3RyaW5naWZ5KGNvbXBpbGVDb250ZXh0LmFzdE1hcFt0b3BvSWRdLCBudWxsLCAyKSk7XG59XG5cbmZ1bmN0aW9uIGdldENvZGVSZXByZXNlbnRhdGlvbk9mKHRvcG9JZCwgY29tcGlsZUNvbnRleHQpIHtcbiAgICBsZXQgbGFzdFNvdXJjZVR5cGUgPSBjb21waWxlQ29udGV4dC5tYXBPZlRva2VuVG9NZXRhLmdldCh0b3BvSWQpO1xuXG4gICAgaWYgKGxhc3RTb3VyY2VUeXBlICYmIChsYXN0U291cmNlVHlwZS50eXBlID09PSBBU1RfQkxLX1BST0NFU1NPUl9DQUxMIHx8IGxhc3RTb3VyY2VUeXBlLnR5cGUgPT09IEFTVF9CTEtfQUNUSVZBVE9SX0NBTEwpKSB7XG4gICAgICAgIC8vZm9yIG1vZGlmaWVyLCBqdXN0IHVzZSB0aGUgZmluYWwgcmVzdWx0XG4gICAgICAgIHJldHVybiBKc0xhbmcuYXN0VmFyUmVmKGxhc3RTb3VyY2VUeXBlLnRhcmdldCwgdHJ1ZSk7XG4gICAgfVxuXG4gICAgbGV0IGFzdCA9IGNvbXBpbGVDb250ZXh0LmFzdE1hcFt0b3BvSWRdO1xuICAgIGlmIChhc3QudHlwZSA9PT0gJ01lbWJlckV4cHJlc3Npb24nICYmIGFzdC5vYmplY3QubmFtZSA9PT0gJ2xhdGVzdCcpIHtcbiAgICAgICAgcmV0dXJuIEpzTGFuZy5hc3RDb25kaXRpb25hbChcbiAgICAgICAgICAgIEpzTGFuZy5hc3RDYWxsKCdsYXRlc3QuaGFzT3duUHJvcGVydHknLCBbIGFzdC5wcm9wZXJ0eS52YWx1ZSBdKSwgLyoqIHRlc3QgKi9cbiAgICAgICAgICAgIGFzdCwgLyoqIGNvbnNlcXVlbnQgKi9cbiAgICAgICAgICAgIHsgLi4uYXN0LCBvYmplY3Q6IHsgLi4uYXN0Lm9iamVjdCwgbmFtZTogJ2V4aXN0aW5nJyB9IH1cbiAgICAgICAgKTsgICBcbiAgICB9XG5cbiAgICByZXR1cm4gY29tcGlsZUNvbnRleHQuYXN0TWFwW3RvcG9JZF07XG59XG5cbmZ1bmN0aW9uIGNyZWF0ZUNvbXBpbGVDb250ZXh0KG1vZHVsZU5hbWUsIGxvZ2dlciwgc2hhcmVkQ29udGV4dCkge1xuICAgIGxldCBjb21waWxlQ29udGV4dCA9IHtcbiAgICAgICAgbW9kdWxlTmFtZSwgICAgICAgIFxuICAgICAgICBsb2dnZXIsXG4gICAgICAgIHZhcmlhYmxlczoge30sXG4gICAgICAgIHRvcG9Ob2RlczogbmV3IFNldCgpLFxuICAgICAgICB0b3BvU29ydDogbmV3IFRvcG9Tb3J0KCksXG4gICAgICAgIGFzdE1hcDoge30sIC8vIFN0b3JlIHRoZSBBU1QgZm9yIGEgbm9kZVxuICAgICAgICBtYXBPZlRva2VuVG9NZXRhOiBuZXcgTWFwKCksIC8vIFN0b3JlIHRoZSBzb3VyY2UgY29kZSBibG9jayBwb2ludFxuICAgICAgICBtb2RlbFZhcnM6IG5ldyBTZXQoKSxcbiAgICAgICAgbWFwT2ZGdW5jdG9yVG9GaWxlOiAoc2hhcmVkQ29udGV4dCAmJiBzaGFyZWRDb250ZXh0Lm1hcE9mRnVuY3RvclRvRmlsZSkgfHwge30sIC8vIFVzZSB0byByZWNvcmQgaW1wb3J0IGxpbmVzXG4gICAgICAgIG5ld0Z1bmN0b3JGaWxlczogKHNoYXJlZENvbnRleHQgJiYgc2hhcmVkQ29udGV4dC5uZXdGdW5jdG9yRmlsZXMpIHx8IFtdXG4gICAgfTtcblxuICAgIGNvbXBpbGVDb250ZXh0Lm1haW5TdGFydElkID0gY3JlYXRlVG9wb0lkKGNvbXBpbGVDb250ZXh0LCAnJG1haW4nKTtcblxuICAgIGxvZ2dlci52ZXJib3NlKGBDcmVhdGVkIGNvbXBpbGF0aW9uIGNvbnRleHQgZm9yIFwiJHttb2R1bGVOYW1lfVwiLmApO1xuXG4gICAgcmV0dXJuIGNvbXBpbGVDb250ZXh0O1xufVxuXG5mdW5jdGlvbiBpc1RvcExldmVsQmxvY2sodG9wb0lkKSB7XG4gICAgcmV0dXJuIHRvcG9JZC5pbmRleE9mKCc6YXJnWycpID09PSAtMSAmJiB0b3BvSWQuaW5kZXhPZignJGNhc2VzWycpID09PSAtMSAmJiB0b3BvSWQuaW5kZXhPZignJGV4Y2VwdGlvbnNbJykgPT09IC0xO1xufVxuXG5mdW5jdGlvbiByZXBsYWNlVmFyUmVmU2NvcGUodmFyUmVmLCB0YXJnZXRTY29wZSkge1xuICAgIGlmIChfLmlzUGxhaW5PYmplY3QodmFyUmVmKSkge1xuICAgICAgICBhc3NlcnQ6IHZhclJlZi5vb2xUeXBlID09PSAnT2JqZWN0UmVmZXJlbmNlJztcblxuICAgICAgICByZXR1cm4geyBvb2xUeXBlOiAnT2JqZWN0UmVmZXJlbmNlJywgbmFtZTogcmVwbGFjZVZhclJlZlNjb3BlKHZhclJlZi5uYW1lLCB0YXJnZXRTY29wZSkgfTsgICAgICAgIFxuICAgIH0gXG5cbiAgICBhc3NlcnQ6IHR5cGVvZiB2YXJSZWYgPT09ICdzdHJpbmcnO1xuXG4gICAgbGV0IHBhcnRzID0gdmFyUmVmLnNwbGl0KCcuJyk7XG4gICAgYXNzZXJ0OiBwYXJ0cy5sZW5ndGggPiAxO1xuXG4gICAgcGFydHMuc3BsaWNlKDAsIDEsIHRhcmdldFNjb3BlKTtcbiAgICByZXR1cm4gcGFydHMuam9pbignLicpO1xufVxuXG5tb2R1bGUuZXhwb3J0cyA9IHtcbiAgICBjb21waWxlUGFyYW0sXG4gICAgY29tcGlsZUZpZWxkLFxuICAgIGNvbXBpbGVEYk9wZXJhdGlvbixcbiAgICBjb21waWxlRXhjZXB0aW9uYWxSZXR1cm4sXG4gICAgY29tcGlsZVJldHVybixcbiAgICBjcmVhdGVUb3BvSWQsXG4gICAgY3JlYXRlQ29tcGlsZUNvbnRleHQsXG4gICAgZGVwZW5kc09uLFxuICAgIGFkZENvZGVCbG9jayxcblxuICAgIEFTVF9CTEtfRklFTERfUFJFX1BST0NFU1MsXG4gICAgQVNUX0JMS19QUk9DRVNTT1JfQ0FMTCxcbiAgICBBU1RfQkxLX1ZBTElEQVRPUl9DQUxMLFxuICAgIEFTVF9CTEtfQUNUSVZBVE9SX0NBTEwsXG4gICAgQVNUX0JMS19WSUVXX09QRVJBVElPTixcbiAgICBBU1RfQkxLX1ZJRVdfUkVUVVJOLFxuICAgIEFTVF9CTEtfSU5URVJGQUNFX09QRVJBVElPTixcbiAgICBBU1RfQkxLX0lOVEVSRkFDRV9SRVRVUk4sIFxuICAgIEFTVF9CTEtfRVhDRVBUSU9OX0lURU0sXG5cbiAgICBPT0xfTU9ESUZJRVJfQ09ERV9GTEFHXG59OyJdfQ==