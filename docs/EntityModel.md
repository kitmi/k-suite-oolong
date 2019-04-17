# Entity Model

## static members

* db
    * connector - Getter
    * createNewConnector - Create a new connector, usually used for transaction
* meta - Metadata about the enttiy
    * knowledge 
        * dependsOnExisting
* i18n - I18n object

## operation context

There are predefined context properties which can be accessed in an entity operation as listed below.

* raw - Raw input data. 
* latest - Validated and sanitized data.
* existing - Existing data from database.
* i18n - I18n object.
* connector - Existing connector for chained operation.
* result - Operation result
* entities - Access other entity models in the same schema
* schemas - Access other schema models in the same application
* state - Current request state

## operation options

* connector - Transaction connector.

## semantic symbols

* supported symbols 
    * @@now - Current datetime value

## special tokens

* oolType

    Oolong Language Syntax Types (design time)

    * General Value Types
        * ObjectReference
        * ConstReference
        * StringTemplate
        * PipedValue
        * FunctionCall
        * RegExp
        * JavaScript

    * Modifiers    
        * Validator - |~, read as "Ensure"
        * Processor - |>,  
        * Activator - |=, read as "Set to"   

    * Data Operations
        * findOne
        * DoStatement

    * Statements & Expressions
        * cases
        * ConditionalStatement
        * ReturnExpression    
        * ThrowExpression
        * UnaryExpression
        * ValidateExpression
        * BinaryExpression
        * LogicalExpression

* oorType

    Oolong Runtime Types (run time)

    * SymbolToken
    * SessionVariable
    * QueryVariable



