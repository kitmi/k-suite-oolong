"use strict";

const Util = require('rk-utils');
const { _, fs } = Util;
const { extractDriverAndConnectorName } = require('../utils/lang');

exports.commands = {    
    'build': 'Generate database scripts and entity models.',
    'migrate': 'Create database structure.',    
    'dataset': 'List available data set.',
    'import': 'Import data set.',
    'reverse': 'Reverse engineering from a databse.',
    'listValidators': 'List all builtin validators.'
};

/**
 * @param {OolongCore} core - OolongCore object.
 */
exports.options = (core) => {
    let cmdOptions = {};

    cmdOptions['c'] = {
        desc: "Oolong config file",
        alias: [ "conf", "config" ],                
        inquire: true,
        promptMessage: 'Please input the config file path:',
        promptDefault: "conf/oolong.json",
        onReady: async () => core.startContainer()
    };  

    switch (core.command) {
        case 'build':
            break;

        case 'migrate':
            cmdOptions['r'] = {
                desc: 'Reset all data if the database exists',
                promptMessage: 'Reset existing database?',
                promptDefault: false,
                inquire: true,
                required: true,
                alias: [ 'reset' ],
                isBool: true
            };
            break;        

        case 'dataset': 
            cmdOptions['schema'] = {
                desc: 'The schema to list',                
                promptMessage: 'Please select a schema:',
                inquire: true,
                required: true,
                promptType: 'list',
                choicesProvider: () => core.getSchemasInConfig()
            };
            break;

        case 'import':
            cmdOptions['schema'] = {
                desc: 'The schema to list',                
                promptMessage: 'Please select a schema:',
                inquire: true,
                required: true,
                promptType: 'list',
                choicesProvider: () => core.getSchemasInConfig()
            };
            cmdOptions['dataset'] = {
                desc: 'The name of the data set to import',
                promptMessage: 'Please select the target dataset:',
                alias: [ 'ds', 'data' ],
                inquire: true,
                promptType: 'list',
                choicesProvider: () => core.getDataset_()
            };
            break;

        case 'reverse':        
            cmdOptions['conn'] = {
                desc: 'The data source connector',
                alias: [ 'connector' ],
                promptMessage: 'Please select the data source connector:',
                inquire: true,
                required: true,
                promptType: 'list',
                choicesProvider: () => Object.keys(core.connectionStrings),
                afterInquire: () => { console.log('The conenction string of selected connector:', connectionStrings[core.option('conn')]); }                
            };
            break;

        case 'listValidators':
            break;    
        
        default:
            //module general options
            break;
    }

    return cmdOptions;
};

exports.main = (core) => {
    if (core.option('v')) {
        console.log('v' + core.app.version);
    } else {
        core.showUsage();
    }
};

exports.build = async (core) => {
    core.app.log('verbose', 'oolong build');

    let oolongConfig = core.oolongConfig;

    let dslSourceDir = Util.getValueByPath(oolongConfig, 'oolong.dslSourceDir');
    if (!dslSourceDir) {
        throw new Error('"oolong.dslSourceDir" not found in oolong config.');
    }

    let modelOutputDir = Util.getValueByPath(oolongConfig, 'oolong.modelOutputDir');
    if (!modelOutputDir) {
        throw new Error('"oolong.modelOutputDir" not found in oolong config.');
    }

    let scriptOutputDir = Util.getValueByPath(oolongConfig, 'oolong.scriptOutputDir');
    if (!scriptOutputDir) {
        throw new Error('"oolong.scriptOutputDir" not found in oolong config.');
    }

    let manifestOutputDir = Util.getValueByPath(oolongConfig, 'oolong.manifestOutputDir');
    
    let dslSourcePath = core.app.toAbsolutePath(dslSourceDir);    
    let modelOutputPath = core.app.toAbsolutePath(modelOutputDir);
    let scriptOutputPath = core.app.toAbsolutePath(scriptOutputDir);
    let manifestOutputPath = manifestOutputDir && core.app.toAbsolutePath(manifestOutputDir);

    if (!fs.existsSync(dslSourcePath)) {
        return Promise.reject(`DSL source directory "${dslSourcePath}" not found.`);
    }

    let useJsonSource = Util.getValueByPath(oolongConfig, 'oolong.useJsonSource', false);       
    let saveIntermediate = Util.getValueByPath(oolongConfig, 'oolong.saveIntermediate', false);       

    return core.api.build_({
        logger: core.app.logger,
        dslSourcePath,
        modelOutputPath,
        scriptOutputPath,
        manifestOutputPath,
        useJsonSource,
        saveIntermediate,
        schemaDeployment: core.schemaDeployment
    });
};

exports.migrate = async (core) => {
    core.app.log('verbose', 'oolong migrate');

    let oolongConfig = core.oolongConfig;

    let modelDir  = Util.getValueByPath(oolongConfig, 'oolong.modelDir');
    if (!modelDir) {
        throw new Error('"oolong.modelDir" not found in oolong config.');
    }

    let dslSourceDir = Util.getValueByPath(oolongConfig, 'oolong.dslSourceDir');
    if (!dslSourceDir) {
        throw new Error('"oolong.dslSourceDir" not found in oolong config.');
    }

    let scriptSourceDir = Util.getValueByPath(oolongConfig, 'oolong.scriptSourceDir');
    if (!scriptSourceDir) {
        throw new Error('"oolong.scriptSourceDir" not found in oolong config.');
    }

    let modelPath = core.app.toAbsolutePath(modelDir);    
    let dslSourcePath = core.app.toAbsolutePath(dslSourceDir);    
    let scriptSourcePath = core.app.toAbsolutePath(scriptSourceDir);

    if (!fs.existsSync(modelPath)) {
        return Promise.reject(`Model directory "${modelPath}" not found.`);
    }

    if (!fs.existsSync(dslSourcePath)) {
        return Promise.reject(`DSL source directory "${dslSourcePath}" not found.`);
    }

    if (!fs.existsSync(scriptSourcePath)) {
        return Promise.reject(`Database scripts directory "${scriptSourcePath}" not found.`);
    }

    let useJsonSource = Util.getValueByPath(oolongConfig, 'oolong.useJsonSource', false);

    return core.api.migrate_({
        logger: core.app.logger,
        modelPath,
        dslSourcePath,        
        scriptSourcePath,
        useJsonSource,
        schemaDeployment: core.schemaDeployment
    }, core.option('reset'));
};

exports.dataset = async (core) => {
    core.app.log('verbose', 'oolong dataset');

    let dataset = await core.getDataset_();
    
    core.app.log('info', 'Available dataset: \n' + dataset.join('\n') + '\n');
}

exports.import = async (core) => {
    core.app.log('verbose', 'oolong import');

    let oolongConfig = core.oolongConfig;

    let modelDir  = Util.getValueByPath(oolongConfig, 'oolong.modelDir');
    if (!modelDir) {
        throw new Error('"oolong.modelDir" not found in oolong config.');
    }

    let scriptSourceDir = Util.getValueByPath(oolongConfig, 'oolong.scriptSourceDir');
    if (!scriptSourceDir) {
        throw new Error('"oolong.scriptSourceDir" not found in oolong config.');
    }
    
    let modelPath = core.app.toAbsolutePath(modelDir);    
    let scriptSourcePath = core.app.toAbsolutePath(scriptSourceDir);

    let schema = core.option('schema');    
    let dataset = core.option('dataset');    

    return core.api.import_({
        logger: core.app.logger,        
        modelPath,
        scriptSourcePath,        
        schemaDeployment: core.schemaDeployment
    }, schema, dataset);
}

exports.reverse = async (core) => {
    core.app.log('verbose', 'oolong reverse');

    let oolongConfig = core.oolongConfig;

    let dslReverseOutputDir = Util.getValueByPath(oolongConfig, 'oolong.dslReverseOutputDir');
    if (!dslReverseOutputDir) {
        throw new Error('"oolong.dslOutputDir" not found in oolong config.');
    }

    let outputDir = core.getReverseOutputDir(core.app.toAbsolutePath(dslReverseOutputDir));

    //todo: relocation, and deep copy connection options
    let conn = core.option('conn');
    let [ driver ] = extractDriverAndConnectorName(conn);
    let connOptions = Util.getValueByPath(oolongConfig, 'dataSource.' + conn);
    assert: connOptions;    

    if (typeof connOptions.reverseRules === 'string') {
        connOptions.reverseRules = require(core.app.toAbsolutePath(connOptions.reverseRules));
    } 

    assert: !connOptions.reverseRules || _.isPlainObject(connOptions.reverseRules);

    return core.api.reverse_({ 
        logger: core.app.logger,
        dslReverseOutputPath: outputDir,
        driver,
        connOptions
    });
};

exports.listValidators = async (core) => {
    core.app.log('verbose', 'oolong listValidators');

    let list = core.api.getValidatorList();

    core.app.log('info', 'Available validators: \n' + list.join('\n') + '\n');
}