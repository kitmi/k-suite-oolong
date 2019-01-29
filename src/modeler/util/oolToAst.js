"use strict";

/**
 * @module
 * @ignore
 */

const { _ } = require('rk-utils');
const { TopoSort } = require('@k-suite/algorithms');

const JsLang = require('./ast.js');
const OolTypes = require('../../lang/OolTypes');
const { isDotSeparateName, extractDotSeparateName, extractReferenceBaseName } = require('../../lang/OolUtils');
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

/**
 * Compile a conditional expression
 * @param {object} test
 * @param {object} compileContext
 * @property {string} compileContext.moduleName
 * @property {TopoSort} compileContext.topoSort
 * @property {object} compileContext.astMap - Topo Id to ast map
 * @param {string} startTopoId
 * @returns {string} Topo Id
 */
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

            assert: retTopoId === endTopoId;

            /*
            compileContext.astMap[endTopoId] = JsLang.astCall('_.isEmpty', astArgument);

            switch (test.operator) {
                case 'exists':
                    compileContext.astMap[endTopoId] = JsLang.astNot(JsLang.astCall('_.isEmpty', astArgument));
                    break;

                case 'is-not-null':
                    compileContext.astMap[endTopoId] = JsLang.astNot(JsLang.astCall('_.isNil', astArgument));
                    break;

                case 'not-exists':
                    
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
            */

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

            compileContext.astMap[endTopoId] = JsLang.astBinExp(
                getCodeRepresentationOf(lastLeftId, compileContext),
                op,
                getCodeRepresentationOf(lastRightId, compileContext)
            ); 

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

            compileContext.astMap[endTopoId] = JsLang.astBinExp(
                getCodeRepresentationOf(lastLeftId, compileContext),
                op,
                getCodeRepresentationOf(lastRightId, compileContext)
            ); 

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

/**
 * Compile a validator called in a logical expression.
 * @param value
 * @param functors
 * @param compileContext
 * @param topoInfo
 * @property {string} topoInfo.topoIdPrefix
 * @property {string} topoInfo.lastTopoId
 * @returns {*|string}
 */
function compileAdHocValidator(topoId, value, functor, compileContext) {
    assert: functor.oolType === OolTypes.Modifier.VALIDATOR;        

    let callArgs;
    
    if (functor.args) {
        callArgs = translateArgs(topoId, functor.args, compileContext);        
    } else {
        callArgs = [];
    }            
    
    let arg0 = value;
    
    compileContext.astMap[topoId] = JsLang.astCall('Validators.' + functor.name, [ arg0 ].concat(callArgs));

    return topoId;
}

/**
 * Compile a modifier from ool to ast.
 * @param topoId - startTopoId
 * @param value
 * @param functors
 * @param compileContext
 * @param topoInfo
 * @property {string} topoInfo.topoIdPrefix
 * @property {string} topoInfo.lastTopoId
 * @returns {*|string}
 */
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
            //let existingRef =            
            arg0 = JsLang.astConditional(
                JsLang.astCall('latest.hasOwnProperty', [ extractReferenceBaseName(value.name) ]), /** test */
                value, /** consequent */
                replaceVarRefScope(value, 'existing')
            );  
        }
        compileContext.astMap[topoId] = JsLang.astCall(functorId, [ arg0 ].concat(callArgs));
    }    

    if (isTopLevelBlock(topoId)) {
        let targetVarName = value.name;
        let needDeclare = false;

        if (!isDotSeparateName(value.name) && compileContext.variables[value.name] && functor.oolType !== OolTypes.Modifier.VALIDATOR) {
            //conflict with existing variables, need to rename to another variable
            let counter = 1;
            do {
                counter++;       
                targetVarName = value.name + counter.toString();         
            } while (compileContext.variables.hasOwnProperty(targetVarName));            

            compileContext.variables[targetVarName] = { type: 'localVariable', source: 'modifier' };
            needDeclare = true;
        }

        //if (compileContext.variables[])

        addCodeBlock(compileContext, topoId, {
            type: OOL_MODIFIER_CODE_FLAG[functor.oolType],
            target: targetVarName,
            references,   // latest., exsiting., raw.
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

/**
 * Check whether a functor is user-defined or built-in
 * @param functor
 * @param compileContext
 * @param args - Used to make up the function signature
 * @returns {string} functor id
 */
function translateModifier(functor, compileContext, args) {
    let functionName, fileName, functorId;

    //extract validator naming and import information
    if (isDotSeparateName(functor.name)) {
        let names = extractDotSeparateName(functor.name);
        if (names.length > 2) {
            throw new Error('Not supported reference type: ' + functor.name);
        }

        //reference to other entity file
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

/**
 * Compile a piped value from ool to ast.
 * @param {string} startTopoId - The topological id of the starting process to the target value, default as the param name
 * @param {object} varOol - Target value ool node.
 * @param {object} compileContext - Compilation context.
 * @property {string} compileContext.moduleName
 * @property {TopoSort} compileContext.topoSort
 * @property {object} compileContext.astMap - Topo Id to ast map
 * @returns {string} Last topo Id
 */
function compilePipedValue(startTopoId, varOol, compileContext) {
    let lastTopoId = compileConcreteValueExpression(startTopoId, varOol.value, compileContext);

    varOol.modifiers.forEach(modifier => {
        let modifierStartTopoId = createTopoId(compileContext, startTopoId + OOL_MODIFIER_OP[modifier.oolType] + modifier.name);
        dependsOn(compileContext, lastTopoId, modifierStartTopoId);

        lastTopoId = compileModifier(
            modifierStartTopoId,
            varOol.value,
            modifier,
            compileContext
        );
    });

    return lastTopoId;
}

/**
 * Compile a variable reference from ool to ast.
 * @param {string} startTopoId - The topological id of the starting process to the target value, default as the param name
 * @param {object} varOol - Target value ool node.
 * @param {object} compileContext - Compilation context.
 * @property {string} compileContext.moduleName
 * @property {TopoSort} compileContext.topoSort
 * @property {object} compileContext.astMap - Topo Id to ast map
 * @returns {string} Last topo Id
 */
function compileVariableReference(startTopoId, varOol, compileContext) {
    pre: _.isPlainObject(varOol) && varOol.oolType === 'ObjectReference';

    //let [ baseName, others ] = varOol.name.split('.', 2);
    /*
    if (compileContext.modelVars && compileContext.modelVars.has(baseName) && others) {
        varOol.name = baseName + '.data' + '.' + others;
    }*/    

    //simple value
    compileContext.astMap[startTopoId] = JsLang.astValue(varOol);
    return startTopoId;
}

/**
 * Get an array of parameter names.
 * @param {array} args - An array of arguments in ool syntax
 * @returns {array}
 */
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

/**
 * Compile a concrete value expression from ool to ast
 * @param {string} startTopoId - The topo id of the starting process to the target value expression
 * @param {object} value - Ool node
 * @param {object} compileContext - Compilation context
 * @returns {string} Last topoId
 */
function compileConcreteValueExpression(startTopoId, value, compileContext) {
    if (_.isPlainObject(value)) {
        if (value.oolType === 'PipedValue') {
            return compilePipedValue(startTopoId, value, compileContext);
        }

        if (value.oolType === 'ObjectReference') {
            let [ refBase, ...rest ] = extractDotSeparateName(value.name);

            let dependency;

            if (!compileContext.variables[refBase]) {
                throw new Error(`Referenced undefined variable: ${value.name}`);                
            } 

            if (compileContext.variables[refBase].type === 'entity' && !compileContext.variables[refBase].ongoing) {
                dependency = refBase;
            } else if (refBase === 'latest' && rest.length > 0) {
                //latest.password
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

/**
 * Translate an array of function arguments from ool into ast.
 * @param topoId - The modifier function topo 
 * @param args - 
 * @param compileContext - 
 * @returns {Array}
 */
function translateArgs(topoId, args, compileContext) {
    args = _.castArray(args);
    if (_.isEmpty(args)) return [];

    let callArgs = [];

    _.each(args, (arg, i) => {                
        let argTopoId = createTopoId(compileContext, topoId + ':arg[' + (i+1).toString() + ']');
        let lastTopoId = compileConcreteValueExpression(argTopoId, arg, compileContext);

        dependsOn(compileContext, lastTopoId, topoId);

        callArgs = callArgs.concat(_.castArray(getCodeRepresentationOf(lastTopoId, compileContext)));
    });

    return callArgs;
}

/**
 * Compile a param of interface from ool into ast
 * @param index
 * @param param
 * @param compileContext
 * @returns {string}
 */
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
    //let sanitizeStarting;

    //if (index === 0) {
        //declare $sanitizeState variable for the first time
    //    sanitizeStarting = JsLang.astVarDeclare(varRef, callAst, false, false, `Sanitize param "${param.name}"`);
    //} else {
    //let sanitizeStarting = ;

        //let lastPrepareTopoId = '$params:sanitize[' + (index - 1).toString() + ']';
        //dependsOn(compileContext, lastPrepareTopoId, prepareTopoId);
    //}

    compileContext.astMap[prepareTopoId] = [
        JsLang.astAssign(varRef, callAst, `Sanitize argument "${param.name}"`)
    ];

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

/**
 * Compile a model field preprocess information into ast.
 * @param {object} param - Field information
 * @param {object} compileContext - Compilation context
 * @returns {string}
 */
function compileField(paramName, param, compileContext) {
    // 1. reference to the latest object that is passed qualifier checks
    // 2. if modifiers exist, wrap the ref into a piped value
    // 3. process the ref (or piped ref) and mark as end
    // 4. build dependencies: latest.field -> ... -> field:ready 
    let topoId = createTopoId(compileContext, paramName);
    let contextName = 'latest.' + paramName;
    //compileContext.astMap[topoId] = JsLang.astVarRef(contextName, true);

    let value = wrapParamReference(contextName, param);    
    let endTopoId = compileConcreteValueExpression(topoId, value, compileContext);

    let readyTopoId = createTopoId(compileContext, topoId + ':ready');
    dependsOn(compileContext, endTopoId, readyTopoId);

    return readyTopoId;
}

function wrapParamReference(name, value) {
    let ref = Object.assign({ oolType: 'ObjectReference', name: name });
    
    if (!_.isEmpty(value.modifiers)) {
        return { oolType: 'PipedValue', value: ref, modifiers: value.modifiers };
    }
    
    return ref;
}

function hasModelField(operand, compileContext) {
    if (_.isPlainObject(operand) && operand.oolType === 'ObjectReference') {
        let [ baseVar, ...rest ] = operand.name.split('.');

        return compileContext.variables[baseVar] && compileContext.variables[baseVar].ongoing && rest.length > 0;        
    }

    return false;    
}

/**
 * Translate a then clause from ool into ast in return block.
 * @param {string} startId
 * @param {string} endId
 * @param then
 * @param compileContext
 * @returns {object} AST object
 */
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

    //then expression is an oolong concrete value    
    if (_.isArray(then) || _.isPlainObject(then)) {
        let valueEndId = compileConcreteValueExpression(startId, then, compileContext);    
        then = compileContext.astMap[valueEndId]; 
    }   

    return JsLang.astReturn(then);
}

/**
 * Translate a then clause from ool into ast
 * @param {string} startId
 * @param {string} endId
 * @param then
 * @param compileContext
 * @param assignTo
 * @returns {object} AST object
 */
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

        if (then.oolType === 'LogicalExpression') {
            /*
            switch (then.operator) {
                case 'and':
                    op = '&&';
                    break;

                case 'or':
                    op = '||';
                    break;

                default:
                    throw new Error('Unsupported test operator: ' + test.operator);
            }
            */
        }

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
                condition[then.left.name.split('.', 2)[1]] = { [OPERATOR_TOKEN[op]]: compileContext.astMap[lastRightId] };
            }

            return JsLang.astAssign(assignTo, JsLang.astValue(condition));           
        }

        if (then.oolType === 'UnaryExpression') {
            
        }
    }

    //then expression is an oolong concrete value    
    if (_.isArray(then) || _.isPlainObject(then)) {
        let valueEndId = compileConcreteValueExpression(startId, then, compileContext);    
        then = compileContext.astMap[valueEndId]; 
    }   

    return JsLang.astAssign(assignTo, then);
}

/**
 * Translate a return clause from ool into ast
 * @param {string} startTopoId - The topo id of the starting state of return clause
 * @param {string} endTopoId - The topo id of the ending state of return clause
 * @param value
 * @param compileContext
 * @returns {object} AST object
 */
function translateReturnValueAst(startTopoId, endTopoId, value, compileContext) {
    let valueTopoId = compileConcreteValueExpression(startTopoId, value, compileContext);
    if (valueTopoId !== startTopoId) {
        dependsOn(compileContext, valueTopoId, endTopoId);
    }

    return JsLang.astReturn(getCodeRepresentationOf(valueTopoId, compileContext));
}

/**
 * Compile a return clause from ool into ast
 * @param {string} startTopoId - The topo id of the starting process to the target value expression
 * @param value
 * @param compileContext
 * @returns {object} AST object
 */
function compileReturn(startTopoId, value, compileContext) {
    let endTopoId = createTopoId(compileContext, '$return');
    dependsOn(compileContext, startTopoId, endTopoId);

    compileContext.astMap[endTopoId] = translateReturnValueAst(startTopoId, endTopoId, value, compileContext);

    addCodeBlock(compileContext, endTopoId, {
        type: AST_BLK_VIEW_RETURN
    });

    return endTopoId;
}

/**
 * Compile a find one operation from ool into ast
 * @param {int} index
 * @param {object} operation - Ool node
 * @param {object} compileContext -
 * @param {string} dependency
 * @returns {string} last topoId
 */
function compileFindOne(index, operation, compileContext, dependency) {
    pre: dependency;

    let endTopoId = createTopoId(compileContext, 'op$' + index.toString());
    let conditionVarName = endTopoId + '$condition';

    let ast = [
        JsLang.astVarDeclare(conditionVarName)
    ];

    assert: operation.condition;

    compileContext.variables[operation.model] = { type: 'entity', source: 'findOne', ongoing: true };

    if (operation.condition.oolType) {
        //special condition

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

                assert: !Array.isArray(astCaseTtem), 'Invalid case item ast.';

                astCaseTtem = JsLang.astVarDeclare(caseResultVarName, astCaseTtem, true, false, `Condition ${i} for find one ${operation.model}`);

                let ifStart = createTopoId(compileContext, casePrefix + ':then');
                let ifEnd = createTopoId(compileContext, casePrefix + ':end');
                dependsOn(compileContext, lastTopoId, ifStart);
                dependsOn(compileContext, ifStart, ifEnd);

                lastStatement = [
                    astCaseTtem,
                    JsLang.astIf(JsLang.astVarRef(caseResultVarName), JsLang.astBlock(translateThenAst(ifStart, ifEnd, item.then, compileContext, conditionVarName)), lastStatement)
                ];
                dependsOn(compileContext, ifEnd, endTopoId);
            });

            ast = ast.concat(_.castArray(lastStatement));
        } else {
            throw new Error('todo');
        }


    } else {
        throw new Error('todo');
    }

    ast.push(
        JsLang.astVarDeclare(operation.model, JsLang.astAwait(`this.findOne_`, JsLang.astVarRef(conditionVarName)))
    );

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
            //prepareDbConnection(compileContext);
            throw new Error('tbi');
            break;

        case 'update':
            throw new Error('tbi');
            //prepareDbConnection(compileContext);
            break;

        case 'create':
            throw new Error('tbi');
            //prepareDbConnection(compileContext);
            break;

        case 'delete':
            throw new Error('tbi');
            //prepareDbConnection(compileContext);
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

/**
 * Compile exceptional return 
 * @param {object} oolNode
 * @param {object} compileContext
 * @param {string} [dependency]
 * @returns {string} last topoId
 */
function compileExceptionalReturn(oolNode, compileContext, dependency) {
    pre: (_.isPlainObject(oolNode) && oolNode.oolType === 'ReturnExpression');

    let endTopoId = createTopoId(compileContext, '$return'), lastExceptionId = dependency;

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

                compileContext.astMap[exceptionEndId] = JsLang.astIf(
                    getCodeRepresentationOf(lastTopoId, compileContext),
                    JsLang.astBlock(translateReturnThenAst(
                        thenStartId,
                        exceptionEndId,
                        item.then, compileContext)),
                    null,
                    `Return on exception #${i}`
                );

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

    assert: !compileContext.topoSort.hasDependency(name), 'Already in topoSort!';

    compileContext.topoNodes.add(name);

    return name;
}

function dependsOn(compileContext, previousOp, currentOp) {
    pre: previousOp !== currentOp, 'Self depending';

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
    //compileContext.logger.debug('AST:\n' + JSON.stringify(compileContext.astMap[topoId], null, 2));
}

function getCodeRepresentationOf(topoId, compileContext) {
    let lastSourceType = compileContext.mapOfTokenToMeta.get(topoId);

    if (lastSourceType && (lastSourceType.type === AST_BLK_PROCESSOR_CALL || lastSourceType.type === AST_BLK_ACTIVATOR_CALL)) {
        //for modifier, just use the final result
        return JsLang.astVarRef(lastSourceType.target, true);
    }

    let ast = compileContext.astMap[topoId];
    if (ast.type === 'MemberExpression' && ast.object.name === 'latest') {
        return JsLang.astConditional(
            JsLang.astCall('latest.hasOwnProperty', [ ast.property.value ]), /** test */
            ast, /** consequent */
            { ...ast, object: { ...ast.object, name: 'existing' } }
        );   
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
        astMap: {}, // Store the AST for a node
        mapOfTokenToMeta: new Map(), // Store the source code block point
        modelVars: new Set(),
        mapOfFunctorToFile: (sharedContext && sharedContext.mapOfFunctorToFile) || {}, // Use to record import lines
        newFunctorFiles: (sharedContext && sharedContext.newFunctorFiles) || []
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
        assert: varRef.oolType === 'ObjectReference';

        return { oolType: 'ObjectReference', name: replaceVarRefScope(varRef.name, targetScope) };        
    } 

    assert: typeof varRef === 'string';

    let parts = varRef.split('.');
    assert: parts.length > 1;

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