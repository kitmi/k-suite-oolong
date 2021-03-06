const Util = require('rk-utils'); 
const { _, fs } = Util;
const inquirer = require('inquirer');
const path = require('path');
const Commands = require('./commands');
const OolongApi = require('../lang/api');
const { makeDataSourceName, SupportedDrivers } = require('../utils/lang');
const { ServiceContainer } = require('@k-suite/app');

/**
 * Oolong command line helper core class.
 * @class
 */
class OolongCore {
    constructor(app) {
        this.app = app;
        this.api = OolongApi;
    }
    
    /**
     * Reparse command line arguments with command specific options.
     */
    async initialize_() {        
        this.usageOptions = _.cloneDeep(this.app.config.commandLineOptions);
        let commandLineOptions = this.app.features['commandLineOptions'];

        this.showUsage = (err) => {
            let injects = {};

            if (err) {
                injects.afterBanner = () => (err.message || err) + '\n\n';
            }

            if (this.command && this.command !== 'main') {
                injects.afterCommandLine = () => `Command "${this.command}": ` + Commands.commands[this.command] +'\n\n';
            } else {
                injects.afterCommandLine = () => 'Available commands:\n' + _.reduce(Commands.commands, (result, desc, cmd) => result + `  ${cmd}: ${desc}\n`, '') + '\n'
            }            

            console.log(commandLineOptions.getUsage(this.app, this.usageOptions, injects));
        }

        //extract module and command
        let command = this.app.argv._[0];
        
        this.command = _.camelCase(command);

        if (this.command === 'commands' || this.command === 'options') {
            this.command = undefined;
            return false;
        }    
        
        this.action_ = Commands[this.command];

        if (typeof this.action_ !== 'function') {         
            this.command = undefined;   
            return false;
        }

        let commandOptions = Commands.options(this);
        Object.assign(this.usageOptions.options, commandOptions);

        //re-parse arguments according to settings
        this.argv = commandLineOptions.parseArgv(this.usageOptions.options);   

        if (this.command !== 'main' && !this.option('?')) {
            if (!this.option('s')) {
                await this.inquire_();
            } else {
                this._fillCommandDefaults(commandOptions);
                await this.startContainer();
            }

            if (!this._validateArgv()) {
                return false;
            }
        }

        return true;
    }

    option(name) {
        return this.argv[name];
    }    

    async execute_() {
        if (this.option('?')) {
            this.showUsage();
        } else {
            return this.action_(this);
        }
    }    

    async inquire_() {
        let doInquire = item => inquirer.prompt([item]).then(answers => {
            _.forOwn(answers, (ans, name) => {
                this.argv[name] = ans;
                let opts = this.usageOptions.options[name];
                if (opts.alias) {
                    _.each(opts.alias, a => { this.argv[a] = ans; });
                }
            })
        }); 
        
        return Util.eachAsync_(this.usageOptions.options, async (opts, name) => {
            if (('inquire' in opts) && !(name in this.argv)) {
                let inquire = opts.inquire;
                
                if (typeof opts.inquire === 'function') {
                    inquire = await opts.inquire();
                }

                if (inquire) {
                    let type;
                    let q = { name: name, message: opts.promptMessage || opts.desc };

                    if (opts.promptType) {
                        type = opts.promptType;
                        if (type === 'list' || type  === 'rawList' || type === 'checkbox' || type === 'expand') {
                            if (!opts.choicesProvider) {
                                throw new Error('Missing choices provider!');
                            }

                            q.choices = await opts.choicesProvider();
                        }
                    } else if (opts.bool) {
                        type = 'confirm';
                    } else {
                        type = 'input'
                    }

                    q.type = type;

                    if ('promptDefault' in opts) {
                        if (typeof opts.promptDefault === 'function') {
                            q.default = await opts.promptDefault();
                        } else {
                            q.default = opts.promptDefault;
                        }
                    }

                    await doInquire(q);

                    if (opts.afterInquire) {
                        await opts.afterInquire();
                    }

                    console.log();
                }
            } else if (name in this.argv && opts.nonInquireFilter) {
                //nonInquire
                this.argv[name] = await opts.nonInquireFilter(this.argv[name]);
            } 

            if (name in this.argv && opts.onReady) {
                await opts.onReady(this.argv[name]);
            }
        });
    }

    async startContainer() {
        let configFile = this.option('config');
        
        let configFullPath = this.app.toAbsolutePath(configFile);

        if (!(await fs.exists(configFullPath))) {
            throw new Error(`Config "${configFile}" not found!`);
        }

        let extName = path.extname(configFullPath);
        if (extName !== '.json') {
            throw new Error('Only supports JSON config.');
        }

        let configName = path.basename(configFullPath, extName);
        let configPath = path.dirname(configFullPath);
        let envAware = false;

        if (configName.endsWith('.default')) {
            envAware = true;
            configName = configName.substr(0, configName.length - 8);
        }

        this.container = new ServiceContainer('OolongContainer', {
            workingPath: this.app.workingPath,
            configPath,
            configName,
            disableEnvAwareConfig: !envAware,
            allowedFeatures: [
                'runtimeEnv',
                'configByHostname',                    
                'devConfigByGitUser',                
                'loggers',
                'mailer',                
                'settings',
                'timezone',
                'version',
                'restClient',
                'simpleCrawler',
                'soapClient',
                'oolong',
                'dataSource'
            ]
        });

        this.container.logger = this.app.logger;

        return this.container.start_();
    }

    /**
     * Get connection strings from a config file.
     * @param {*} conf - Ooolong config file.
     * @returns {object}
     */
    getConnectionStrings() {
        let config = this.oolongConfig;
        let result = {};
        
        SupportedDrivers.forEach(driver => {
            let connectors = config[driver];

            if (connectors) {
                _.forOwn(connectors, (connectorOptions, connectorName) => {
                    result[makeDataSourceName(driver, connectorName)] = connectorOptions.connection;
                });
            }
        });

        return result;
    }

    getSchemasInConfig() {
        let schemas = Util.getValueByPath(this.oolongConfig, 'oolong.schemaDeployment');
        return Object.keys(schemas);
    }

    async getDataset_() {
        let scriptSourcePath = this.app.toAbsolutePath(Util.getValueByPath(this.oolongConfig, 'oolong.scriptSourceDir'));

        let schema = this.option('schema'); 
        if (!schema) {
            throw new Error(`Schema argument is required for listing dataset.`);
        }  

        return this.api.dataset_(
            { 
                logger: this.app.logger,
                scriptSourcePath, 
                schemaDeployment: this.schemaDeployment 
            },
            schema
        );
    }

    get oolongConfig() {
        return this.container.config;
    }

    get schemaDeployment() {
        let modelMapping = Util.getValueByPath(this.oolongConfig, 'oolong.schemaDeployment');

        if (_.isEmpty(modelMapping)) {
            throw new Error('"schemaDeployment" is empty.');
        }

        return _.mapValues(modelMapping, (mapping, schemaName) => {
            let { dataSource, ...others } = mapping;
    
            if (!dataSource) {
                throw new Error(`Configuration item "schemaDeployment.${schemaName}.dataSource" not found.`);
            }
    
            let { connection, ...options } = Util.getValueByPath(this.oolongConfig, 'dataSource.' + dataSource, {});
            if (!connection) {
                throw new Error(`Connection string of data source "${dataSource}" not found.`);
            }
    
            return { dataSource, connectionString: connection, options, ...others };
        });
    }

    /**
     * Get default oolong output path.
     * @param {string} prefix 
     * @param {bool} override 
     * @returns {string} Output path of oolong generated files.
     */
    getReverseOutputDir(baseDir, prefix = '', override = false) {
        let now = new Date();
        let folder = `${prefix}${now.getFullYear()}-${now.getMonth()+1}-${now.getDate()}`;
        let outputDir = path.join(baseDir, folder);

        if (override) return outputDir;

        let num = 1;

        while (fs.existsSync(outputDir)) {
            let folder2 = folder + '_' + (++num).toString();
            outputDir = path.join(baseDir, folder2);
        }

        return outputDir;
    }

    // validate parsed and filled argument options.
    _validateArgv() {
        let valid = true;

        _.forOwn(this.usageOptions.options, (opts, name) => {
            let required = opts.required;

            if (typeof required === 'function') {
                required = required();
            } 

            if (required && !(name in this.argv)) {
                console.error(`Argument "${name}" is required.`);
                valid = false;
            }
        });

        return valid;
    }

    // fill the argv with command specific prompt defaults
    _fillCommandDefaults(commandOptions) {
        _.forOwn(commandOptions, (info, option) => {
            if (!this.argv.hasOwnProperty(option) && info.hasOwnProperty('promptDefault')) {
                this.argv[option] = info.promptDefault;
            }
        });
    }
}

module.exports = OolongCore;