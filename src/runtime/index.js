"use strict";

const Types = require('./types'); 
const Errors = require('./Errors');
const Activators = require('./Activators');
const Convertors = require('./Convertors');
const Processors = require('./Processors');
const Validators = require('./Validators');
const Generators = require('./Generators');
const Connector = require('./Connector');
const Lang = require('../utils/lang');

module.exports = { 
    Types, 
    Errors, 
    Activators,
    Convertors, 
    Processors, 
    Validators, 
    Generators, 
    Connector,     
    Utils: { Lang },
    getEntityModelOfDriver: driver => require('./drivers/' + driver + '/EntityModel')
};