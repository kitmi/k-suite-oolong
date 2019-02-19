/* Oolong Parser for Jison */

/* JS declaration */
%{
    //used to calculate the amount by bytes unit
    const UNITS = new Map([['K', 1024], ['M', 1048576], ['G', 1073741824], ['T', 1099511627776]]);

    //paired brackets
    const BRACKET_PAIRS = {
        '}': '{',
        ']': '[',
        ')': '('
    };

    //top level keywords
    const TOP_LEVEL_KEYWORDS = new Set(['import', 'type', 'const', 'schema', 'entity', 'dataset', 'view']);

    const SUB_KEYWORDS = { 
        // level 1
        'schema': new Set(['entities', 'views']),
        'entity': new Set(['with', 'has', 'associations', 'key', 'index', 'data', 'interface', 'mixes']),
        'dataset': new Set(['is']),
    
        // level 2
        'entity.associations': new Set(['hasOne', 'hasMany', 'refersTo', 'belongsTo']),
        'entity.index': new Set(['is', 'unique']),
        'entity.interface': new Set(['accept', 'find', 'findOne', 'return']),

        'dataset.body': new Set(['with']),

        // level 3
        'entity.associations.item': new Set(['connectedBy', 'when', 'being', 'with', 'as', 'optional']),        
        'entity.interface.find': new Set(['a', 'an', 'the', 'one', 'by', 'cases', 'selected', 'selectedBy', "of", "which", "where", "when", "with", "otherwise", "else"]),           
        'entity.interface.return': new Set(["unless", "when"]),           

        // level 4
        'entity.associations.item.when': new Set(['being']),        
        'entity.interface.find.when': new Set(['when', 'else', 'otherwise']),           
        'entity.interface.find.else': new Set(['return', 'throw']),

        'entity.interface.return.when': new Set(['exists', 'null', 'throw']),

        // level 5
        'entity.associations.item.when.being': new Set(['with', 'when'])
    };

    const NEXT_STATE = {
        'entity.associations.hasOne': 'entity.associations.item',
        'entity.associations.hasMany': 'entity.associations.item',
        'entity.associations.refersTo': 'entity.associations.item',
        'entity.associations.belongsTo': 'entity.associations.item',
        'entity.associations.item.when': 'entity.associations.item.when',
        'entity.associations.item.when.being': 'entity.associations.item.when.being',

        'entity.interface.accept': 'entity.interface.accept',
        'entity.interface.find': 'entity.interface.find',
        'entity.interface.findOne': 'entity.interface.find',
        'entity.interface.return': 'entity.interface.return',
        'entity.interface.return.when': 'entity.interface.return.when',
        'entity.interface.find.when': 'entity.interface.find.when',
        'entity.interface.find.otherwise': 'entity.interface.find.else',
        'entity.interface.find.else': 'entity.interface.find.else',

        'dataset.is': 'dataset.body'
    };

    const DEDENT_STOPPER = new Set([                
        'entity.associations.item.when.being'
    ]);

    const NEWLINE_STOPPER = new Set([                
        'import', 
        'type', 
        'const', 
        'entity',
        'entity.key', 
        'entity.data', 
        'entity.interface.return.when', 
        'entity.mixes',
        'entity.associations.item'
    ]);

    const NEWLINE_STOPPER_INDENT_EXCEPTION = new Set([                
        'entity.associations.item'
    ]);

    const STATE_STOPPER = {                
        'entity.associations.item.when.being': new Set(['when']),
        'entity.interface.find.when': new Set(['else', 'otherwise'])
    };

    const FINAL_STATE = {        
        'entity.interface.find.else': 'entity.interface.find'
    };

    const SUPPORT_WORD_OPERATOR = new Set([
        'entity.interface.find.when',
        'entity.interface.return.when',
        'entity.associations.item.when'                
    ]);

    //indented child starting state
    const CHILD_KEYWORD_START_STATE = new Set([ 'EMPTY', 'DEDENTED' ]);    
    
    const BUILTIN_TYPES = new Set([ 'any', 'array', 'binary', 'blob', 'bool', 'boolean', 'buffer', 'datetime', 'decimal', 'enum', 'float', 'int', 'integer', 'number', 'object', 'string', 'text', 'timestamp' ]);

    class ParserState {
        constructor() {
            this.indents = [];
            this.indent = 0;
            this.dedented = 0;
            this.eof = false;
            this.comment = false;
            this.brackets = [];
            this.state = {};
            this.stack = [];
            this.newlineStopFlag = [];
        }

        get hasOpenBracket() {
            return this.brackets.length > 0;
        }

        get lastIndent() {
            return this.indents.length > 0 ? this.indents[this.indents.length - 1] : 0;
        }

        get hasIndent() {
            return this.indents.length > 0;
        }

        markNewlineStop(flag) {
            this.newlineStopFlag[this.newlineStopFlag.length-1] = flag;
        }

        doIndent() {
            this.indents.push(this.indent);

            if (NEWLINE_STOPPER_INDENT_EXCEPTION.has(this.lastState)) {
                this.markNewlineStop(false);
            }
        }

        doDedent() {
            this.dedented = 0;

            while (this.indents.length) {
                this.dedented++;
                this.indents.pop();
                if (this.lastIndent === this.indent) break;
            }

            if (this.lastIndent !== this.indent) {
                throw new Error('Cannot align to any of the previous indented block!');
            }

            if (this.dedented === 0) {
                throw new Error('Inconsistent indentation!');
            }

            if (DEDENT_STOPPER.has(state.lastState)) {
                state.exitState(state.lastState);
            }
        }

        doNewline() {
            if (state.hasIndent && this.newlineStopFlag[this.newlineStopFlag.length-1]) {
                state.exitState(state.lastState);
            }        
        }

        dedentAll() {
            this.indent = 0;
            this.dedented = this.indents.length;
            this.indents = [];
        }

        dump(loc, token) {
            if (1) {
                token ? console.log(loc, token) : console.log(loc);
                console.log('indents:', this.indents.join(' -> '), 'current indent:', this.indent, 'current dedented:', this.dedented, 'nl stop', this.newlineStopFlag);                   
                console.log('lastState:', this.lastState, 'comment:', this.comment, 'eof:', this.eof, 'brackets:', this.brackets.join(' -> '),'stack:', this.stack.join(' -> '));
                console.log();
            }
            
            return this;
        }

        void() {
            return undefined;
        }

        val(value) {
            return value;
        }

        enterObject() {            
            return this.enterState('object');
        }

        exitObject() {            
            return this.exitState('object');
        }

        enterArray() {
            return this.enterState('array');
        }

        exitArray() {
            return this.exitState('array');
        }

        get lastState() {
            return this.stack.length > 0 ? this.stack[this.stack.length - 1] : undefined;
        }

        enterState(state) {
            console.log('> enter state:', state, '\n');
            this.stack.push(state);
            this.newlineStopFlag.push(NEWLINE_STOPPER.has(state) ? true : false);
            return this;
        }

        exitState(state) {
            console.log('< exit state:', state, '\n');
            let last = this.stack.pop();
            if (state !== last) {
                throw new Error(`Unmatched "${state}" state!`);
            }

            let finalStateToExit = FINAL_STATE[last];

            if (finalStateToExit) {
                do {
                    last = this.stack.pop(); 
                    console.log('< exit state:', last, '\n');
                } while (last !== finalStateToExit);
            }

            this.newlineStopFlag.pop();

            return this;
        }

        parseSize(size) {
            if (UNITS.has(size.substr(-1))) {
                let unit = size.substr(-1);
                let factor = UNITS[unit];
        
                size = size.substr(0, size.length - 1);
        
                return parseInt(size) * factor;
            } else {
                return parseInt(size);
            }
        }
        
        unquoteString(str, quotes) {
            return str.substr(quotes, str.length-quotes*2);
        }

        normalizeSymbol(ref) {
            return { oorType: 'SymbolToken', name: ref.substr(2) };
        }                
        
        normalizeReference(ref) {
            return { oolType: 'ObjectReference', name: ref.substr(1) };
        }

        normalizeConstReference(ref) {
            return { oolType: 'ConstReference', name: ref };
        }

        normalizeStringTemplate(text) {
            return { oolType: 'StringTemplate', value: this.unquoteString(text, 1) };
        }    

        normalizeValidator(name, args) {
            if (args) {
                return { oolType: 'Validator', name, args };
            } 
                
            return { oolType: 'Validator', name  };
        }

        normalizeRegExp(regexp) {                
            return { oolType: 'RegExp', value: regexp };
        }

        normalizeScript(script) {                
            return { oolType: 'JavaScript', value: script };
        }

        normalizeProcessor(name, args) {
            if (args) {
                return { oolType: 'Processor', name, args };
            } 
                
            return { oolType: 'Processor', name  };
        }

        normalizeActivator(name, args) {
            if (args) {
                return { oolType: 'Activator', name, args };
            } 
                
            return { oolType: 'Activator', name  };
        }

        normalizePipedValue(value, modifiers) {
            return Object.assign({ oolType: 'PipedValue', value }, modifiers);
        }

        normalizeFunctionCall(func) {
            return Object.assign({ oolType: 'FunctionCall' }, func);
        }

        isTypeExist(type) {
            return this.state.type && (type in this.state.type);
        }    

        validate() {
            let errors = [];

            if (errors && errors.length > 0) {
                throw new Error(errors.join("\n"));
            }

            return this;
        }

        build() {
            return this.state;
        }

        import(namespace) {
            if (!this.state.namespace) {
                this.state.namespace = [];
            }

            this.state.namespace.push(namespace);
        }  
        
        define(type, name, value, line) {
            if (!this.state[type]) {
                this.state[type] = {};
            }

            if (name in this.state[type]) {
                throw new Error(`Duplicate ${type} definition detected at line ${line}.`);
            }

            this.state[type][name] = value;
        }

        defineConstant(name, value, line) {
            this.define('constant', name, value, line);
        }

        defineType(name, value, line) {
            if (!value.type) {
                throw new Error(`Missing type property for type "${name}" at line: ${line}!`);
            }

            this.define('type', name, value, line);
        }

        isTypeExist(type) {
            return this.state.type && (type in this.state.type);
        }
        
        defineEntity(name, value, line) {
            this.define('entity', name, value, line);
        }

        isEntityExist(entity) {
            return this.state.entity && (entity in this.state.entity);
        }

        addToEntity(name, extra) {
            if (!this.isEntityExist(name)) {
                throw new Error(`Entity "${name}" not exists.`);
            }

            Object.assign(this.state.entity[name], extra);
        }

        defineSchema(name, value, line) {
            this.define('schema', name, value, line);    
        }

        defineRelation(name, value, line) {
            this.define('relation', name, value, line);    
        }

        defineView(name, value, line) {
            this.define('view', name, value, line);
        }

        defineDataset(name, value, line) {
            this.define('dataset', name, value, line);
        }
    }

    function merge(obj1, obj2) {
        let m = Object.assign({}, obj1);

        for (let k in obj2) {
            let v2 = obj2[k];
            let t2 = typeof v2;

            if (k in obj1) {
                let v1 = obj1[k];
                let t1 = typeof v1;

                if (t1 === 'object' || t2 === 'object') {
                    if (t1 !== 'undefined' && t1 !== 'object') {
                        throw new Error(`Failed to merge object propery "${k}".`);
                    }

                    if (t2 !== 'undefined' && t2 !== 'object') {
                        throw new Error(`Failed to merge object propery "${k}".`);
                    }

                    m[k] = Object.assign({}, v1, v2);
                    continue;
                }

                Array.isArray(v1) || (v1 = [ v1 ]);
                Array.isArray(v2) || (v2 = [ v2 ]);
                m[k] = v1.concat(v2);
                continue;
            }

            m[k] = v2;
        }

        return m;
    }

    let state; // created on start
%}

%lex

%options easy_keyword_rules
%options flex

uppercase               [A-Z]
lowercase               [a-z]
digit                   [0-9]

space           		\ |\t
newline		            \n|\r\n|\r|\f

// identifiers
element_access          {variable}"["({space})*?({variable}|{shortstring}|{integer})({space})*?"]"
member_access           {identifier}("."{identifier})+
variable                {member_access}|{identifier}
object_reference        "@"{variable}
symbol_token            "@""@"{identifier}

identifier              ({id_start})({id_continue})*
id_start                "_"|"$"|({uppercase})|({lowercase})
id_continue             {id_start}|{digit}

bool_value              "true"|"false"|"yes"|"no"|"on"|"off"

// numbers 
bytes                   {integer}("B"|"b")
bit_integer             {integer}("K"|"M"|"G"|"T")
big_integer             {integer}"n"
integer                 ({decinteger})|({hexinteger})|({octinteger})
decinteger              ("-")?(([1-9]{digit}*)|"0")
hexinteger              "0"[x|X]{hexdigit}+
octinteger              "0"[o|O]{octdigit}+
bininteger              "0"[b|B]{bindigit}+
hexdigit                {digit}|[a-fA-F]
octdigit                [0-7]
bindigit                [0|1]

floatnumber             {exponentfloat}|{pointfloat}
exponentfloat           ("-")?({digit}+|{pointfloat}){exponent}
pointfloat              ("-")?({digit}*{fraction})|({digit}+".")
fraction                "."{digit}+
exponent                [e|E][\+|\-]({digit})+

// regexp literal
regexp                  "/"{regexp_item}*"/"{regexp_flag}*
regexp_item             {regexp_char}|{escapeseq}
regexp_char             [^\\\n\/]
regexp_flag             "i"|"g"|"m"|"y"

// reserved
symbol_operators        {relation_operators}|{syntax_operators}|{math_operators}
word_operators          {logical_operators}|{math_operators2}|{relation_operators2}
bracket_operators       "("|")"|"["|"]"|"{"|"}"
syntax_operators        "|~"|","|":"|"|>"|"|="|"--"|"=>"|"~"|"="|"->"
comment_operators       "//"
relation_operators      "!="|">="|"<="|">"|"<"|"=="
logical_operators       "not"|"and"|"or"
math_operators          "+"|"-"|"*"|"/"
math_operators2         "mod"|"div"
relation_operators2     "in"|"is"|"like"

// javascript
javascript              "<js>"{longstringitem}*?"</js>"
block_comment           "/*"{longstringitem}*?"*/"

// strings
jststring               "`"{longstringitem}*?"`"

longstring              {longstring_double}|{longstring_single}
longstring_double       '"""'{longstringitem}*?'"""'
longstring_single       "'''"{longstringitem}*?"'''"
longstringitem          {longstringchar}|{escapeseq}
longstringchar          [^\\]

shortstring             {shortstring_double}|{shortstring_single}
shortstring_double      '"'{shortstringitem_double}*?'"'
shortstring_single      "'"{shortstringitem_single}*?"'"
shortstringitem_double  {shortstringchar_double}|{escapeseq}
shortstringitem_single  {shortstringchar_single}|{escapeseq}
shortstringchar_single  [^\\\n\']
shortstringchar_double  [^\\\n\"]
escapeseq               \\.

// INITIAL program start
// EMPTY new line start
// DEDENTS after DEDENTS
// INLINE inline
// OBJECT_KEY inside a object, key part
// OBJECT_VALUE inside a array, value part
// ARRAY inside a array
// FUNCTION
%s INITIAL EMPTY DEDENTED INLINE REPARSE

%%

<INITIAL><<EOF>>        return 'EOF';

<INITIAL>.|\n           %{  //start the program
                            state = new ParserState();
                            this.unput(yytext);
                            this.begin('EMPTY');
                        %}

<EMPTY><<EOF>>          %{ 
                            if (state.indents.length > 0) {
                                //reach end-of-file, but a current block still not in ending state

                                //put back the eof
                                this.unput(' ');

                                //dedent all
                                state.dedentAll();
                                state.eof = true;
                                state.dump('<EMPTY><<EOF>>');
                                this.begin('DEDENTED');

                            } else {          
                                state.dump('<EMPTY><<EOF>>');                      
                                return 'EOF';
                            }
                        %}
<EMPTY>\                %{ state.indent++; %}
<EMPTY>\t               %{ state.indent = (state.indent + 8) & -7; %}
<EMPTY>\n               %{ state.indent = 0; if (state.comment) state.comment = false; %} // blank line
<EMPTY,INLINE>{comment_operators}.*      %{ state.comment = true; %} /* skip comments */
<EMPTY,INLINE>{block_comment}  %{  /* skip comments */ %}
<EMPTY>.                %{
                            this.unput( yytext )
                            //compare the current indents with the last
                            var last = state.lastIndent;
                            if (state.indent > last) {
                                //new indent
                                state.doIndent();
                                this.begin('INLINE');
                                state.dump('<EMPTY>. indent');                                                            
                                return 'INDENT';

                            } else if (state.indent < last) {
                                //dedent
                                state.doDedent();
                                this.begin('DEDENTED');                                  

                                state.dump('<EMPTY>. dedent');   
                            } else {
                                //same indent
                                this.begin('INLINE');

                                if (!state.hasIndent) {
                                    if (state.lastState === 'type.info') {
                                        state.exitState('type.info');
                                    }

                                    if (state.lastState === 'type.name') {
                                        state.exitState('type.name');
                                    }
                                }                                                                                

                                state.dump('<EMPTY>. same indent');                                       
                            }
                        %}
<DEDENTED>.|<<EOF>>     %{
                            if (state.dedented > 0 && state.dedented-- > 0) {
                                this.unput(yytext);                                        

                                if (state.lastState === 'type.info') {
                                    state.exitState('type.info');
                                }  

                                if (state.lastState === 'type.name') {
                                    state.exitState('type.name');
                                }  
                                
                                if (state.lastState) {
                                    state.exitState(state.lastState);                      
                                }
                                
                                state.dump('<DEDENTED>.|<<EOF>> DEDENT');
                                return 'DEDENT';

                            } else if (state.eof) {
                                this.popState();
                                state.dump('<DEDENTED>.|<<EOF>> pop');
                                while (state.lastState) {
                                    state.exitState(state.lastState);                      
                                }

                            } else {
                                if (state.indent === 0) {
                                    while (state.lastState) {
                                        state.exitState(state.lastState);                      
                                    }
                                }

                                state.dedented = 0;
                                this.unput(yytext);
                                this.begin('INLINE');
                                state.dump('<DEDENTED>.|<<EOF>> INLINE');
                            }
                        %}
<INLINE><<EOF>>         %{
                            if (state.indents.length > 0) {
                                //reach end-of-file, but a current block still not in ending state

                                //put back the eof
                                this.unput(' ');

                                //dedent all
                                state.dedentAll();
                                state.eof = true;
                                state.dump('<INLINE><<EOF>>');
                                this.begin('DEDENTED');
                                return 'NEWLINE';

                            } else {                                
                                state.dump('<INLINE><<EOF>>');   

                                if (state.lastState) {
                                    //stack not empty   
                                    if (state.lastState === 'type.info') {
                                        state.exitState('type.info');
                                    }  

                                    if (state.lastState === 'type.name') {
                                        state.exitState('type.name');
                                    }  
                                    
                                    if (state.lastState) {
                                        state.exitState(state.lastState);                      
                                    }                      

                                    //put back the eof
                                    this.unput(' ');
                                    state.eof = true;
                                    this.begin('EMPTY');
                                    return 'NEWLINE';
                                }

                                return 'EOF';
                            }
                        %}       
<INLINE>{javascript}    %{
                            yytext = state.normalizeScript(yytext.substr(4, yytext.length-9).trim());
                            return 'SCRIPT';
                        %}
<INLINE>{jststring}     %{
                            yytext = state.normalizeStringTemplate(yytext);
                            return 'STRING';
                        %}

<INLINE>{longstring}    %{
                            yytext = state.unquoteString(yytext, 3);
                            return 'STRING';
                        %}
<INLINE>{shortstring}   %{
                            yytext = state.unquoteString(yytext, 1);
                            return 'STRING';
                        %}
<INLINE>{newline}       %{
                            // implicit line joining
                            if (!state.hasOpenBracket) {                                
                                this.begin('EMPTY');

                                if (state.comment) {
                                    state.comment = false;
                                }

                                state.dump('<INLINE>{newline}');                                
                                state.indent = 0;

                                state.doNewline();                          

                                return 'NEWLINE';
                            }
                        %}
<INLINE>{space}+       /* skip whitespace, separate tokens */
<INLINE>{regexp}        %{
                            yytext = state.normalizeRegExp(yytext);
                            return 'REGEXP';
                        %}   
<INLINE>{floatnumber}   %{
                            yytext = parseFloat(yytext);
                            return 'FLOAT';
                        %}
<INLINE>{bit_integer}   %{
                            yytext = state.parseSize(yytext);
                            return 'INTEGER';
                        %}
<INLINE>{bytes}         %{                            
                            yytext = parseInt(yytext.substr(0, yytext.length - 1));
                            if (yytext[yytext.length - 1] === 'B') {
                                yytext *= 8;
                            }
                            return 'BITS';
                        %}
<INLINE>{integer}       %{
                            yytext = parseInt(yytext);
                            return 'INTEGER';
                        %}
<INLINE>{element_access}   %{                                
                                return 'ELEMENT_ACCESS';
                           %}                        
<INLINE>{member_access}    %{                                
                                return 'DOTNAME';
                           %}
<INLINE>{symbol_token}     %{
                                yytext = state.normalizeSymbol(yytext);
                                return 'SYMBOL';
                           %}                      
<INLINE>{object_reference} %{
                                yytext = state.normalizeReference(yytext);
                                return 'REFERENCE';
                           %}
<INLINE>{bracket_operators}     %{
                                    if (yytext == '{' || yytext == '[' || yytext == '(') {
                                        state.brackets.push(yytext);
                                    } else if (yytext == '}' || yytext == ']' || yytext == ')') {
                                        var paired = BRACKET_PAIRS[yytext];
                                        var lastBracket = state.brackets.pop();
                                        if (paired !== lastBracket) {
                                            throw new Error("Inconsistent bracket.")
                                        }
                                    }

                                    if (yytext == '{') {
                                        state.enterObject();
                                    } else if (yytext == '}') {
                                        state.exitObject();
                                    } else if (yytext == '[') {
                                        state.enterArray();
                                    } else if (yytext == ']') {
                                        state.exitArray();
                                    }

                                    return yytext;
                                %}
<INLINE>{bool_value}       %{
                                yytext = (yytext === 'true' || yytext === 'on' || yytext === 'yes');
                                return 'BOOL';
                           %}
<INLINE>{word_operators}    %{
                                state.dump(this.topState(1) + ' -> <INLINE>{word_operators}', yytext);                                     

                                if (SUPPORT_WORD_OPERATOR.has(state.lastState)) {
                                    return yytext;
                                } else {
                                    this.unput(yytext);
                                    this.begin('REPARSE');
                                }                                
                            %}
<REPARSE,INLINE>{identifier}        %{        
                                if (this.topState(0) !== 'INLINE') {
                                    this.begin('INLINE');
                                }
                                if (!state.lastState) {
                                    if (TOP_LEVEL_KEYWORDS.has(yytext)) {
                                        state.enterState(yytext);
                                        return yytext;
                                    }

                                    throw new Error(`Invalid syntax: ${yytext}`);
                                }       

                                state.dump(this.topState(1) + ' -> <INLINE>{identifier}', yytext);                                     

                                switch (state.lastState) {
                                    case 'schema':
                                        if (state.hasIndent && SUB_KEYWORDS['schema'].has(yytext)) {
                                            state.enterState('schema.' + yytext);
                                            return yytext;
                                        }
                                        break;

                                    case 'type': 
                                        state.enterState('type.name');
                                        return 'NAME';

                                    case 'type.name':
                                        state.enterState('type.info');

                                        if (BUILTIN_TYPES.has(yytext)) {                                        
                                            return yytext;
                                        }
                                        break;

                                    case 'entity':
                                        if (state.hasIndent && SUB_KEYWORDS['entity'].has(yytext)) {
                                            state.enterState('entity.' + yytext);                                                                        
                                            return yytext;
                                        } else if (!state.hasIndent && yytext === 'extends') {
                                            return yytext;
                                        } 
                                        break;

                                    default:
                                        if (SUB_KEYWORDS[state.lastState] && SUB_KEYWORDS[state.lastState].has(yytext)) {
                                            if (STATE_STOPPER[state.lastState] && STATE_STOPPER[state.lastState].has(yytext)) {
                                                state.exitState(state.lastState);                                                                        
                                            }

                                            let keywordChain = state.lastState + '.' + yytext;
                                            let nextState = NEXT_STATE[keywordChain];
                                            if (nextState) {
                                                state.enterState(nextState);                                                                        
                                            }
                                            return yytext;
                                        }
                                        break;                                    
                                }                                         

                                return 'NAME';
                            %}
<INLINE>{symbol_operators}  return yytext;

/lex

%right "="
%left "=>"
%left "or"
%left "and"
%nonassoc "in" "is" "like" "~"
%left "not"
%left "!=" ">=" "<=" ">" "<" "=="
%left "+" "-"
%left "*" "/" "mod" "div"
%left "|>" "|~" "|="

%ebnf

%start program

%%

/** grammar **/
program
    : input 
        {
            var r = state;
            state = null;
            return r ? r.validate().build() : '';
        }
    ;

input
    : EOF
    | input0 EOF
    ;

input0
    : statement
    | statement input0
    ;

statement
    : import_statement    
    | const_statement
    | type_statement
    | schema_statement    
    | entity_statement
    | view_statement
    | dataset_statement
    ;

import_statement
    : "import" STRING NEWLINE -> state.dump('import').import($2) 
    | "import" NEWLINE INDENT import_statement_block DEDENT 
    ;

import_statement_block
    : STRING NEWLINE -> state.import($1)
    | STRING NEWLINE import_statement_block -> state.import($1)
    ;

const_statement
    : "const" const_statement_item NEWLINE
    | "const" NEWLINE INDENT const_statement_block DEDENT
    ;

const_statement_item
    : identifier "=" literal
        {
            state.defineConstant($1, $3, @1.first_line);   
        }
    ;

const_statement_block
    : const_statement_item NEWLINE
    | const_statement_item NEWLINE const_statement_block
    ;

schema_statement
    : "schema" identifier_or_string NEWLINE INDENT schema_statement_block DEDENT -> state.defineSchema($2, $5, @1.first_line)
    ;

schema_statement_block
    : comment_or_not schema_entities schema_views_or_not -> Object.assign({}, $1, $2, $3)
    ;

schema_views_or_not
    :
    | schema_views
    ;

schema_entities
    : "entities" NEWLINE INDENT schema_entities_block DEDENT -> { entities: $4 }
    ;

schema_entities_block
    : identifier_or_string NEWLINE -> [ { entity: $1 } ]
    | identifier_or_string NEWLINE schema_entities_block -> [ { entity: $1 } ].concat($3)
    ;

schema_views
    : "views" NEWLINE INDENT schema_views_block DEDENT -> { views: $4 }
    ;

schema_views_block
    : identifier_or_string NEWLINE -> [ $1 ]
    | identifier_or_string NEWLINE schema_views_block -> [ $1 ].concat($3)
    ;

type_statement
    : "type" type_statement_item NEWLINE
    | "type" NEWLINE INDENT type_statement_block DEDENT
    ;

type_statement_item
    /* 
    there are three kinds of modifiers: validator, processor and activator 
        validator: take subject as the first arg
        processor: take subject as the first arg
        activator: assign value to the subject
        activator should only appear before validator and processor
    */
    : identifier_or_string type_base type_info_or_not type_modifiers_or_not field_comment_or_not
        {            
            if (BUILTIN_TYPES.has($1)) throw new Error('Cannot use built-in type "' + $1 + '" as a custom type name. Line: ' + @1.first_line);
            // default as text
            state.defineType($1, Object.assign({type: 'text'}, $2, $3, $4, $5));
        }
    ;

type_statement_block
    : type_statement_item NEWLINE
    | type_statement_item NEWLINE type_statement_block
    ;

type_base
    : ':' types -> $2
    ;

types
    : int_keyword -> { type: 'integer' }
    | number_keyword -> { type: 'number' }    
    | text_keyword -> { type: 'text' }
    | bool_keyword -> { type: 'boolean' }
    | binary_keyword -> { type: 'binary' }
    | datetime_keyword -> { type: 'datetime' }
    | 'any'  -> { type: 'any' }
    | 'enum' -> { type: 'enum' }
    | 'array' -> { type: 'array' }
    | 'object' -> { type: 'object' }
    | identifier_or_string -> { type: $1 }
    ;

int_keyword
    : 'int'
    | 'integer'
    ;

number_keyword
    : 'number'
    | 'float' 
    | 'decimal'
    ;

text_keyword
    : 'text'
    | 'string'
    ;    

bool_keyword
    : 'bool'
    | 'boolean'
    ;

binary_keyword
    : 'blob'
    | 'binary'
    | 'buffer'
    ;

datetime_keyword
    : 'datetime'
    | 'timestamp'
    ;    

type_info_or_not
    :
    | type_infos
    ;

type_infos
    : type_info
    | type_info type_infos -> Object.assign({}, $1, $2)
    ;

type_info
    : identifier -> { [$1]: true }
    | narrow_function_call -> { [$1.name]: $1.args  }
    ;    

type_modifiers_or_not
    : 
    | type_modifiers -> { modifiers: $1 }
    ;     

type_modifiers
    : type_modifier -> [ $1 ]
    | type_modifier type_modifiers -> [ $1 ].concat($2)
    ;

type_modifier
    : "|~" identifier -> state.normalizeValidator($2)
    | "|~" general_function_call -> state.normalizeValidator($2.name, $2.args)
    | "|>" identifier -> state.normalizeProcessor($2)
    | "|>" general_function_call -> state.normalizeProcessor($2.name, $2.args)
    | "|=" identifier -> state.normalizeActivator($2)
    | "|=" general_function_call -> state.normalizeActivator($2.name, $2.args)
    ;

entity_statement
    : entity_statement_header NEWLINE -> state.defineEntity($1[0], $1[1], @1.first_line)
    | entity_statement_header NEWLINE INDENT entity_statement_block DEDENT -> state.defineEntity($1[0], Object.assign({}, $1[1], $4), @1.first_line)
    ;

entity_statement_header
    : entity_statement_header0 -> [ $1, {} ]
    | entity_statement_header0 "extends" identifier_or_string_list -> [ $1, { base: $3 } ]    
    ;

entity_statement_header0
    : "entity" identifier_or_string -> $2
    ;

entity_statement_block
    : comment_or_not entity_sub_items -> Object.assign({}, $1, $2)
    ;

entity_sub_items
    : entity_sub_item
    | entity_sub_item entity_sub_items -> merge($1, $2)
    ;

entity_sub_item
    : with_features
    | has_fields
    | associations_statement
    | key_statement
    | index_statement
    | data_statement
    | interfaces_statement
    | mixin_statement
    ;

mixin_statement
    : "mixes" identifier_or_string_list NEWLINE -> { mixins: $2 }
    ;

comment_or_not
    :
    | "--" STRING NEWLINE -> { comment: $2 }
    ;

with_features
    : "with" NEWLINE INDENT with_features_block DEDENT -> { features: $4 }
    ;

with_features_block
    : feature_inject NEWLINE -> [ $1 ]
    | feature_inject NEWLINE with_features_block -> [ $1 ].concat($3)
    ;

has_fields
    : "has" NEWLINE INDENT has_fields_block DEDENT -> { fields: $4 }
    ;

has_fields_block
    : field_item NEWLINE -> { [$1.name]: $1 }
    | field_item NEWLINE has_fields_block -> Object.assign({}, { [$1.name]: $1 }, $3)
    ;

field_item
    : field_item_body field_comment_or_not -> Object.assign({}, $1, $2)
    ;

field_comment_or_not
    :
    | "--" STRING -> { comment: $2 }
    ;    

field_item_body
    : modifiable_field    
    ;

type_base_or_not
    :
    | type_base
    ;    

associations_statement
    : "associations" NEWLINE INDENT associations_block DEDENT -> { associations: $4 }
    ;

associations_block
    : association_item NEWLINE -> [ $1 ]
    | association_item NEWLINE associations_block -> [ $1 ].concat($3)
    ;

association_item
    : association_type_referee identifier_or_string (association_through)? (association_as)? (association_qualifiers)* -> { type: $1, destEntity: $2, ...$3, ...$4, ...Object.assign({}, ...$5) }    
    | association_type_referee NEWLINE INDENT identifier_or_string association_cases_block (association_as)? (association_qualifiers)* NEWLINE DEDENT -> { type: $1, destEntity: $3, ...$5, ...$6, ...Object.assign({}, ...$7) }
    | association_type_referer identifier_or_string (association_as)? (association_qualifiers)* -> { type: $1, destEntity: $2, ...$3, ...Object.assign({}, ...$4) }      
    ;

association_type_referee
    : "hasOne"
    | "hasMany"
    ;    

association_type_referer
    : "refersTo"
    | "belongsTo"
    ;    

association_through
    : "connectedBy" identifier_string_or_dotname -> { connectedBy: $2 }    
    | "connectedBy" identifier_string_or_dotname "with" conditional_expression -> { connectedBy: $2, connectedWith: $4 }    
    | association_connection -> { remoteField: $1 }     
    | "being" array_of_identifier_or_string -> { remoteField: $2 }      
    ;

association_cases_block
    : ":" NEWLINE INDENT association_cases DEDENT -> { remoteField: $4 } 
    ;    

association_connection
    : "being" identifier_or_string -> $2
    | "being" identifier_or_string association_condition -> { by: $2, with: $3 }     
    ;

association_cases
    : "when" association_connection NEWLINE -> [ $2 ]
    | "when" association_connection NEWLINE association_cases -> [ $2 ].concat( $4 )
    ;    

association_condition
    : "with" conditional_expression -> $2;
    ;

association_as
    : "as" identifier_or_string -> { srcField: $2 }
    ;

association_qualifiers
    : "optional" -> { optional: true }
    | "default" "(" literal ")" -> { default: $literal }
    ;

/*
hasone_keywords
    : "hasOne"
    | "has" "one"
    ;

hasmany_keywords
    : "hasMany"
    | "has" "one"
    ;    
*/

key_statement
    : "key" identifier_or_string NEWLINE -> { key: $2 }
    | "key" array_of_identifier_or_string NEWLINE -> { key: $2 }
    ;

index_statement
    : "index" index_item NEWLINE -> { indexes: [$2] }
    | "index" NEWLINE INDENT index_statement_block DEDENT -> { indexes: $4 }
    ;

index_statement_block
    : index_item NEWLINE -> [ $1 ]
    | index_item NEWLINE index_statement_block -> [ $1 ].concat($3)
    ;

index_item
    : index_item_body
    | index_item_body ("is")? "unique" -> Object.assign({}, $1, { unique: true })
    ;

index_item_body
    : identifier_or_string -> { fields: $1 }
    | array_of_identifier_or_string -> { fields: $1 }
    ;

data_statement
    : "data" inline_object NEWLINE -> { data: $2 }
    | "data" inline_array NEWLINE -> { data: $2 }
    ;

interfaces_statement
    : "interface" NEWLINE INDENT interfaces_statement_block DEDENT -> { interfaces: $4 }
    ;

interfaces_statement_block
    : interface_definition -> Object.assign({}, $1)
    | interface_definition interfaces_statement_block -> Object.assign({}, $1, $2)
    ;

interface_definition
    : identifier_or_string NEWLINE INDENT interface_definition_body DEDENT -> { [$1]: $4 }
    ;

interface_definition_body
    : accept_or_not implementation return_or_not -> Object.assign({}, $1, { implementation: $2 }, $3)
    ;

accept_or_not
    :
    | accept_statement
    ;

accept_statement
    : "accept" modifiable_param NEWLINE -> { accept: [ $2 ] }
    | "accept" NEWLINE INDENT accept_block DEDENT -> { accept: $4 }
    ;

accept_block
    : modifiable_param NEWLINE -> [ $1 ]
    | modifiable_param NEWLINE accept_block -> [ $1 ].concat($3)
    ;

implementation
    : operation -> [ $1 ]
    | operation implementation -> [ $1 ].concat($2)
    ;

operation
    : find_one_operation /*
    | find_list_operation
    | update_operation
    | create_operation
    | delete_operation
    | coding_block
    | assign_operation   */
    ;

find_one_keywords
    : "findOne"
    | "find" article_keyword
    ;

find_one_operation
    : find_one_keywords identifier_or_string selection_inline_keywords conditional_expression -> { oolType: 'findOne', model: $2, condition: $4 }
    | find_one_keywords identifier_or_string case_statement -> { oolType: 'findOne', model: $2, condition: $3 }
    ;    

cases_keywords
    : ":"
    | "by" "cases"    
    | "by" "cases" "as" "below"
    ;   

case_statement
    : cases_keywords NEWLINE INDENT case_condition_block DEDENT -> { oolType: 'cases', items: $4 }
    | cases_keywords NEWLINE INDENT case_condition_block otherwise_statement DEDENT -> { oolType: 'cases', items: $4, else: $5 } 
    ;

case_condition_item
    : "when" conditional_expression "=>" condition_as_result_expression -> { oolType: 'ConditionalStatement', test: $2, then: $4 }
    ; 

case_condition_block
    : case_condition_item -> [ $1 ]
    | case_condition_item case_condition_block -> [ $1 ].concat($2)
    ;

otherwise_statement
    : otherwise_keywords "=>" condition_as_result_expression NEWLINE -> $3
    | otherwise_keywords "=>" stop_controll_flow_expression NEWLINE -> $3
    | otherwise_keywords "=>" NEWLINE INDENT stop_controll_flow_expression NEWLINE DEDENT -> $5
    ;

otherwise_keywords
    : "otherwise"
    | "else"
    ;          

stop_controll_flow_expression
    : return_expression
    | throw_error_expression
    ;

condition_as_result_expression
    : conditional_expression NEWLINE
    | NEWLINE INDENT conditional_expression NEWLINE DEDENT -> $3
    ;

return_expression
    : "return" modifiable_value -> { oolType: 'ReturnExpression', value: $2 }
    ;

throw_error_expression
    : "throw" STRING -> { oolType: 'ThrowExpression', message: $2 }
    | "throw" identifier -> { oolType: 'ThrowExpression', errorType: $2 }
    | "throw" identifier "(" gfc_param_list  ")" -> { oolType: 'ThrowExpression', errorType: $2, args: $4 }
    ;

return_or_not
    :
    | return_expression NEWLINE
        { $$ = { return: $1 }; }
    | return_expression "unless" NEWLINE INDENT return_condition_block DEDENT
        { $$ = { return: Object.assign($1, { exceptions: $5 }) }; }
    ;

return_condition_item
    : "when" conditional_expression "=>" modifiable_value -> { oolType: 'ConditionalStatement', test: $2, then: $4 }    
    | "when" conditional_expression "=>" throw_error_expression -> { oolType: 'ConditionalStatement', test: $2, then: $4 }    
    ;

return_condition_block
    : return_condition_item NEWLINE -> [ $1 ]
    | return_condition_item NEWLINE return_condition_block -> [ $1 ].concat($3)
    ;

update_operation
    : "update" identifier_or_string "with" inline_object where_expr NEWLINE
        { $$ = { oolType: 'update', target: $2, data: $4, filter: $5 }; }
    ;

create_operation
    : "create" identifier_or_string "with" inline_object NEWLINE
        { $$ = { oolType: 'create', target: $2, data: $4 }; }
    ;

delete_operation
    : "delete" identifier_or_string where_expr NEWLINE
        { $$ = { oolType: 'delete', target: $2, filter: $3 }; }
    ;

coding_block
    : "do" "{" javascript "}" NEWLINE
        { $$ = { oolType: 'javascript', script: $3 }; }
    ;

assign_operation
    : "set" identifier_or_member_access "<-" value variable_modifier_or_not NEWLINE
        { $$ = { oolType: 'assignment', left: $2, right: Object.assign({ argument: $4 }, $5) }; }
    ;

entity_fields_selections
    : identifier_or_string -> { entity: $1 }     
    | identifier_or_string "->" inline_array -> { entity: $1, projection: $3 }
    ;

dataset_statement
    : "dataset" identifier_or_string NEWLINE INDENT dataset_statement_block DEDENT -> state.defineDataset($2, $5)
    ;

dataset_statement_block
    : "is" article_keyword_or_not dataset_join_with_item -> $3
    ;

dataset_join_with_block
    : dataset_join_with_item -> [ $1 ]
    | dataset_join_with_item dataset_join_with_block -> [ $1 ].concat($2)
    ;

dataset_join_with_item
    : entity_fields_selections NEWLINE -> $1
    | entity_fields_selections "with" ":" NEWLINE INDENT dataset_join_with_block DEDENT -> { ...$1, with: $6 }
    ;

view_statement
    : "view" identifier_or_string NEWLINE INDENT view_statement_block DEDENT -> state.defineView($2, $5)
    ;

view_statement_block
    : view_main_entity NEWLINE accept_or_not view_selection_or_not group_by_or_not having_or_not order_by_or_not skip_or_not limit_or_not
        -> Object.assign({}, $1, $3, $4, $5, $6, $7, $8, $9)
    ;

view_main_entity
    : "is" article_keyword_or_not identifier_or_string -> { dataset: $3 }
    | "is" article_keyword_or_not identifier_or_string "list" -> { dataset: $3, isList: true }
    ;

view_selection_or_not
    :
    | view_selection
    ;

view_selection
    : selection_inline_keywords conditional_expression NEWLINE -> { condition: $2 }
    ;

article_keyword_or_not
    :
    | article_keyword
    ;

article_keyword
    : "a"
    | "an"
    | "the"
    | "one"
    ;    

selection_attributive_keywords
    : "of" "which"
    | "where" 
    | "when" 
    | "with"
    ;

selection_keywords
    : "selectedBy"
    | "selected" "by"    
    ;    

selection_inline_keywords
    : selection_keywords
    | selection_attributive_keywords
    ;

group_by_or_not
    :
    | "group" "by" identifier_string_or_dotname_list NEWLINE -> { groupBy: $3 }
    | "group" "by" NEWLINE INDENT identifier_string_or_dotname_block DEDENT -> { groupBy: $5 }
    ;

having_or_not
    : 
    | "having" conditional_expression NEWLINE -> { having: $2 }
    ;    

order_by_or_not
    :
    | "order" "by" order_by_list NEWLINE -> { orderBy: $3 }
    | "order" "by" NEWLINE INDENT order_by_block DEDENT -> { orderBy: $5 }
    ;

order_by_block
    : order_by_clause NEWLINE -> [ $1 ]
    | order_by_clause NEWLINE order_by_block -> [ $1 ].concat($3)
    ;

order_by_clause
    : identifier_string_or_dotname -> { field: $1, ascend: true }
    | identifier_string_or_dotname "ascend" -> { field: $1, ascend: true }
    | identifier_string_or_dotname "<" -> { field: $1, ascend: true }
    | identifier_string_or_dotname "descend" -> { field: $1, ascend: false }
    | identifier_string_or_dotname ">" -> { field: $1, ascend: false }
    ;

order_by_list
    : order_by_clause -> [ $1 ]
    | order_by_clause order_by_list0 -> [ $1 ].concat($2)
    ;

order_by_list0
    : "," order_by_clause -> [ $2 ]
    | "," order_by_clause order_by_list0 -> [ $2 ].concat($3)
    ;

skip_or_not
    :
    | "offset" INTEGER NEWLINE -> { offset: $2 }
    | "offset" REFERENCE NEWLINE -> { offset: $2 }
    ;

limit_or_not
    :
    | "limit" INTEGER NEWLINE -> { limit: $2 }
    | "limit" REFERENCE NEWLINE -> { limit: $2 }
    ;

/* A field of entity with a series of modifiers, subject should be identifier or quoted string. */
modifiable_field
    : identifier_or_string type_base_or_not type_info_or_not type_modifiers_or_not -> Object.assign({ name: $1, type: $1 }, $2, $3, $4)   
    ;

/* An argument with a series of modifiers to be used in a function call. */
modifiable_value
    : gfc_param0
    | gfc_param0 type_modifiers -> state.normalizePipedValue($1, { modifiers: $2 })
    ;

/* A parameter declared with a series of modifiers to be used in a function signature. */
modifiable_param
    : modifiable_field
    ; 

feature_inject
    : identifier
    | narrow_function_call
    ;

/* simple function call, without modifiable support */
narrow_function_call
    : identifier "(" nfc_param_list ")" -> { name: $1, args: $3 }
    ;    

nfc_param_list
    : nfc_param -> [ $1 ]
    | nfc_param nfc_param_list0 -> [ $1 ].concat($2)
    ;

nfc_param_list0
    : ',' nfc_param -> [ $2 ]
    | ',' nfc_param nfc_param_list0 -> [ $2 ].concat($3)
    ;    

nfc_param
    : literal
    | identifier -> state.normalizeConstReference($1)
    ;

general_function_call
    : identifier "(" gfc_param_list ")" -> { name: $1, args: $3 }
    ;        

gfc_param_list
    : modifiable_value -> [ $1 ]
    | modifiable_value gfc_param_list0 -> [ $1 ].concat($2)
    ;

gfc_param_list0
    : "," modifiable_value -> [ $2 ]
    | "," modifiable_value gfc_param_list0 -> [ $2 ].concat($3)
    ;    

gfc_param0
    : nfc_param
    | REFERENCE
    | general_function_call
    ;    

identifier_string_or_dotname
    : identifier
    | STRING
    | DOTNAME
    ;        

identifier_string_or_dotname_block 
    : identifier_string_or_dotname NEWLINE -> [ $1 ]
    | identifier_string_or_dotname NEWLINE identifier_string_or_dotname_block -> [ $1 ].concat($3)
    ;

identifier_string_or_dotname_list
    : identifier_string_or_dotname -> [ $1 ]
    | identifier_string_or_dotname identifier_string_or_dotname_list0 -> [ $1 ].concat($2) 
    ;

identifier_string_or_dotname_list0
    : "," identifier_string_or_dotname -> [ $2 ]
    | "," identifier_string_or_dotname identifier_string_or_dotname_list0 -> [ $2 ].concat($3)
    ;

identifier_or_string
    : identifier
    | STRING
    ;    

identifier
    : NAME
    ;

literal
    : INTEGER
    | FLOAT
    | BOOL
    | inline_object
    | inline_array
    | REGEXP
    | STRING
    | SCRIPT
    | SYMBOL
    ;    

inline_object
    : "{" "}" -> {}
    | "{" kv_pairs "}" -> $2
    ;

kv_pair_item
    : identifier_or_string ":" modifiable_value -> {[$1]: $3}
    | identifier non_exist -> {[$1]: state.normalizeReference($1)}
    | INTEGER ":" modifiable_value -> {[$1]: $3}
    ;

non_exist
    :
    ;

kv_pairs
    : kv_pair_item
    | kv_pair_item kv_pairs0 -> Object.assign({}, $1, $2)
    ;

kv_pairs0
    : "," kv_pair_item -> $2
    | "," kv_pair_item kv_pairs0 -> Object.assign({}, $2, $3)
    ;

inline_array
    : "[" "]" -> []
    | "[" gfc_param_list "]" -> $2
    ;

array_of_identifier_or_string
    : "[" identifier_or_string_list "]" -> $2
    ;

identifier_or_string_list
    : identifier_or_string -> [ $1 ]
    | identifier_or_string identifier_or_string_list0 -> [ $1 ].concat($2)
    ;

identifier_or_string_list0
    : ',' identifier_or_string -> [ $2 ]
    | ',' identifier_or_string identifier_or_string_list0 -> [ $2 ].concat($3)
    ;            

value
    : nfc_param
    | narrow_function_call -> state.normalizeFunctionCall($1)
    ;

conditional_expression
    : simple_expression
    | logical_expression
    | boolean_expression
    ;

simple_expression
    : unary_expression
    | binary_expression
    | "(" simple_expression ")" -> $2
    ;

unary_expression
    : modifiable_value "exists" -> { oolType: 'UnaryExpression', operator: 'exists', argument: $1 }
    | modifiable_value "not" "exists" -> { oolType: 'UnaryExpression', operator: 'not-exists', argument: $1 }
    | modifiable_value "is" "null" -> { oolType: 'UnaryExpression', operator: 'is-null', argument: $1 }
    | modifiable_value "is" "not" "null" -> { oolType: 'UnaryExpression', operator: 'is-not-null', argument: $1 }
    | "not" "(" simple_expression ")" -> { oolType: 'UnaryExpression', operator: 'not', argument: $3, prefix: true }
    ;

boolean_expression
    : modifiable_value "~" identifier -> { oolType: 'ValidateExpression', caller: $1, callee: state.normalizeValidator($3) }
    | modifiable_value "~" REGEXP -> { oolType: 'ValidateExpression', caller: $1, callee: state.normalizeValidator($3) }
    | modifiable_value "~" general_function_call -> { oolType: 'ValidateExpression', caller: $1, callee: state.normalizeValidator($3.name, $3.args) }
    ;    

binary_expression
    : modifiable_value ">" modifiable_value -> { oolType: 'BinaryExpression', operator: '>', left: $1, right: $3 }
    | modifiable_value "<" modifiable_value  -> { oolType: 'BinaryExpression', operator: '<', left: $1, right: $3 }
    | modifiable_value ">=" modifiable_value -> { oolType: 'BinaryExpression', operator: '>=', left: $1, right: $3 }
    | modifiable_value "<=" modifiable_value -> { oolType: 'BinaryExpression', operator: '<=', left: $1, right: $3 }
    | modifiable_value "==" modifiable_value -> { oolType: 'BinaryExpression', operator: '==', left: $1, right: $3 }
    | modifiable_value "!=" modifiable_value -> { oolType: 'BinaryExpression', operator: '!=', left: $1, right: $3 }
    | modifiable_value "in" modifiable_value -> { oolType: 'BinaryExpression', operator: 'in', left: $1, right: $3 }
    | modifiable_value "not" "in" modifiable_value -> { oolType: 'BinaryExpression', operator: 'notIn', left: $1, right: $3 }
    /*| value "is" value
        { $$ = { oolType: 'BinaryExpression', operator: 'is', left: $1, right: $3 }; }    
    | value "like" value
        { $$ = { oolType: 'BinaryExpression', operator: 'like', left: $1, right: $3 }; } */     
    ;        

logical_expression
    : simple_expression logical_expression_right -> Object.assign({ left: $1 }, $2)    
    ;

logical_expression_right
    : logical_operators simple_expression -> Object.assign({ oolType: 'LogicalExpression' }, $1, { right: $2 })
    ;

logical_operators
    : "and" -> { operator: 'and' }
    | "or" -> { operator: 'or' }
    ;
