"use strict";

require("source-map-support/register");

const EventEmitter = require('events');

const path = require('path');

const {
  _
} = require('rk-utils');

const {
  generateDisplayName,
  deepCloneField,
  Clonable,
  entityNaming
} = require('./OolUtils');

const Field = require('./Field');

class Entity extends Clonable {
  constructor(linker, name, oolModule, info) {
    super();
    this._events = new EventEmitter();
    this.fields = {};
    this.linker = linker;
    this.name = entityNaming(name);
    this.oolModule = oolModule;
    this.info = info;
  }

  on(eventName, listener) {
    return this._events.on(eventName, listener);
  }

  link() {
    if (!!this.linked) {
      throw new Error("Function  precondition failed: !this.linked");
    }

    this.linker.log('debug', 'Linking entity [' + this.name + '] ...');

    if (this.info.base) {
      let baseEntity = this.linker.loadEntity(this.oolModule, this.info.base);

      if (!baseEntity.linked) {
        throw new Error("Assertion failed: baseEntity.linked");
      }

      this._inherit(baseEntity);
    }

    if (this.info.comment) {
      this.comment = this.info.comment;
    }

    this.displayName = this.comment || generateDisplayName(this.name);

    this._events.emit('featuresMixingIn');

    if (this.info.features) {
      this.info.features.forEach(feature => {
        let featureName;

        if (typeof feature === 'string') {
          featureName = feature;
        } else {
          featureName = feature.name;
        }

        let fn = require(path.resolve(__dirname, `./entityFeatures/${featureName}.js`));

        fn(this, this.linker.translateOolValue(this.oolModule, feature.args));
      });
    }

    this._events.emit('beforeAddingFields');

    if (this.info.fields) {
      _.each(this.info.fields, (fieldInfo, fieldName) => this.addField(fieldName, fieldInfo));
    }

    this._events.emit('afterAddingFields');

    if (this.info.key) {
      this.key = this.info.key;

      if (Array.isArray(this.key) && this.key.length === 1) {
        this.key = this.key[0];
      }
    }

    this._events.emit('beforeAddingInterfaces');

    if (!_.isEmpty(this.info.interfaces)) {
      this.interfaces = _.cloneDeep(this.info.interfaces);

      _.forOwn(this.interfaces, intf => {
        if (!_.isEmpty(intf.accept)) {
          intf.accept = _.map(intf.accept, param => {
            return this.linker.trackBackType(this.oolModule, param);
          });
        }
      });
    }

    this._events.emit('afterAddingInterfaces');

    this.linked = true;
    return this;
  }

  hasIndexOn(fields) {
    fields = fields.concat();
    fields.sort();
    return _.findIndex(this.indexes, index => {
      return _.findIndex(index.fields, (f, idx) => fields.length <= idx || fields[idx] !== f) === -1;
    }) != -1;
  }

  addIndexes() {
    if (this.info.indexes) {
      _.each(this.info.indexes, index => {
        this.addIndex(index);
      });
    }
  }

  addIndex(index) {
    if (!this.indexes) {
      this.indexes = [];
    }

    index = _.cloneDeep(index);

    if (!index.fields) {
      throw new Error("Assertion failed: index.fields");
    }

    if (!_.isArray(index.fields)) {
      index.fields = [index.fields];
    }

    let fields = index.fields;
    index.fields = _.map(fields, field => {
      let normalizedField = _.camelCase(field);

      if (!this.hasField(normalizedField)) {
        throw new Error(`Index references non-exist field: ${field}, entity: ${this.name}.`);
      }

      return normalizedField;
    });
    index.fields.sort();

    if (this.hasIndexOn(index.fields)) {
      throw new Error(`Index on [${index.fields.join(', ')}] already exist in entity [${this.name}].`);
    }

    this.indexes.push(index);
    return this;
  }

  getEntityAttribute(fieldId) {
    if (fieldId[0] === '$') {
      let token = fieldId.substr(1);

      switch (token) {
        case "key":
          return this.fields[this.key];

        case 'feature':
          return this.features;

        default:
          throw new Error(`Filed accessor "${token}" not supported!`);
      }
    } else {
      if (!this.hasField(fieldId)) {
        throw new Error(`Field "${fieldId}" not exists in entity "${this.name}".`);
      }

      return this.fields[fieldId];
    }
  }

  hasField(name) {
    if (Array.isArray(name)) {
      return _.every(name, fn => this.hasField(fn));
    }

    return name in this.fields;
  }

  addAssocField(name, destEntity, destField) {
    let localField = this.fields[name];

    if (localField) {
      throw new Error(`Field "${name}" already exists in entity "${this.name}".`);
    }

    this.addField(name, destField);
  }

  addField(name, rawInfo) {
    if (this.hasField(name)) {
      throw new Error(`Field name [${name}] conflicts in entity [${this.name}].`);
    }

    if (!rawInfo.type) {
      throw new Error("Assertion failed: rawInfo.type");
    }

    let field;

    if (rawInfo instanceof Field) {
      field = rawInfo.clone();
    } else {
      let fullRawInfo = this.linker.trackBackType(this.oolModule, rawInfo);
      field = new Field(name, fullRawInfo);
      field.link();
    }

    this.fields[name] = field;

    if (!this.key) {
      this.key = name;
    }

    return this;
  }

  addFeature(name, feature, allowMultiple) {
    if (!this.features) {
      this.features = {};
    }

    if (allowMultiple) {
      if (!this.features[name]) {
        this.features[name] = [];
      }

      this.features[name].push(feature);
    } else {
      if (feature.name in this.features) {
        throw new Error(`Duplicate feature found: ${name}. Turn on allowMultiple to enable multiple occurrence of a feature.`);
      }

      this.features[name] = feature;
    }

    return this;
  }

  setKey(name) {
    this.key = name;
    return this;
  }

  getReferenceTo(entityName, connectedBy) {
    return this.info.associations && _.find(this.info.associations, assoc => assoc.destEntity === entityName && connectedBy === assoc.connectedBy);
  }

  getKeyField() {
    return Array.isArray(this.key) ? this.key.map(kf => this.fields[kf]) : this.fields[this.key];
  }

  clone() {
    super.clone();
    let entity = new Entity(this.linker, this.name, this.oolModule, this.info);
    deepCloneField(this, entity, 'displayName');
    deepCloneField(this, entity, 'comment');
    deepCloneField(this, entity, 'features');
    deepCloneField(this, entity, 'fields');
    deepCloneField(this, entity, 'accociations');
    deepCloneField(this, entity, 'key');
    deepCloneField(this, entity, 'indexes');
    deepCloneField(this, entity, 'interfaces');
    entity.linked = true;
    return entity;
  }

  toJSON() {
    return {
      name: this.name,
      displayName: this.displayName,
      comment: this.comment,
      features: this.features,
      fields: _.mapValues(this.fields, field => field.toJSON()),
      associations: this.accociations,
      key: this.key,
      indexes: this.indexes
    };
  }

  _inherit(baseEntity) {
    deepCloneField(baseEntity, this, 'features');
    deepCloneField(baseEntity, this, 'fields');
    deepCloneField(baseEntity, this, 'key');
    deepCloneField(baseEntity, this, 'indexes');
  }

}

module.exports = Entity;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9sYW5nL0VudGl0eS5qcyJdLCJuYW1lcyI6WyJFdmVudEVtaXR0ZXIiLCJyZXF1aXJlIiwicGF0aCIsIl8iLCJnZW5lcmF0ZURpc3BsYXlOYW1lIiwiZGVlcENsb25lRmllbGQiLCJDbG9uYWJsZSIsImVudGl0eU5hbWluZyIsIkZpZWxkIiwiRW50aXR5IiwiY29uc3RydWN0b3IiLCJsaW5rZXIiLCJuYW1lIiwib29sTW9kdWxlIiwiaW5mbyIsIl9ldmVudHMiLCJmaWVsZHMiLCJvbiIsImV2ZW50TmFtZSIsImxpc3RlbmVyIiwibGluayIsImxpbmtlZCIsImxvZyIsImJhc2UiLCJiYXNlRW50aXR5IiwibG9hZEVudGl0eSIsIl9pbmhlcml0IiwiY29tbWVudCIsImRpc3BsYXlOYW1lIiwiZW1pdCIsImZlYXR1cmVzIiwiZm9yRWFjaCIsImZlYXR1cmUiLCJmZWF0dXJlTmFtZSIsImZuIiwicmVzb2x2ZSIsIl9fZGlybmFtZSIsInRyYW5zbGF0ZU9vbFZhbHVlIiwiYXJncyIsImVhY2giLCJmaWVsZEluZm8iLCJmaWVsZE5hbWUiLCJhZGRGaWVsZCIsImtleSIsIkFycmF5IiwiaXNBcnJheSIsImxlbmd0aCIsImlzRW1wdHkiLCJpbnRlcmZhY2VzIiwiY2xvbmVEZWVwIiwiZm9yT3duIiwiaW50ZiIsImFjY2VwdCIsIm1hcCIsInBhcmFtIiwidHJhY2tCYWNrVHlwZSIsImhhc0luZGV4T24iLCJjb25jYXQiLCJzb3J0IiwiZmluZEluZGV4IiwiaW5kZXhlcyIsImluZGV4IiwiZiIsImlkeCIsImFkZEluZGV4ZXMiLCJhZGRJbmRleCIsImZpZWxkIiwibm9ybWFsaXplZEZpZWxkIiwiY2FtZWxDYXNlIiwiaGFzRmllbGQiLCJFcnJvciIsImpvaW4iLCJwdXNoIiwiZ2V0RW50aXR5QXR0cmlidXRlIiwiZmllbGRJZCIsInRva2VuIiwic3Vic3RyIiwiZXZlcnkiLCJhZGRBc3NvY0ZpZWxkIiwiZGVzdEVudGl0eSIsImRlc3RGaWVsZCIsImxvY2FsRmllbGQiLCJyYXdJbmZvIiwidHlwZSIsImNsb25lIiwiZnVsbFJhd0luZm8iLCJhZGRGZWF0dXJlIiwiYWxsb3dNdWx0aXBsZSIsInNldEtleSIsImdldFJlZmVyZW5jZVRvIiwiZW50aXR5TmFtZSIsImNvbm5lY3RlZEJ5IiwiYXNzb2NpYXRpb25zIiwiZmluZCIsImFzc29jIiwiZ2V0S2V5RmllbGQiLCJrZiIsImVudGl0eSIsInRvSlNPTiIsIm1hcFZhbHVlcyIsImFjY29jaWF0aW9ucyIsIm1vZHVsZSIsImV4cG9ydHMiXSwibWFwcGluZ3MiOiJBQUFBOzs7O0FBRUEsTUFBTUEsWUFBWSxHQUFHQyxPQUFPLENBQUMsUUFBRCxDQUE1Qjs7QUFDQSxNQUFNQyxJQUFJLEdBQUdELE9BQU8sQ0FBQyxNQUFELENBQXBCOztBQUVBLE1BQU07QUFBRUUsRUFBQUE7QUFBRixJQUFRRixPQUFPLENBQUMsVUFBRCxDQUFyQjs7QUFDQSxNQUFNO0FBQUVHLEVBQUFBLG1CQUFGO0FBQXVCQyxFQUFBQSxjQUF2QjtBQUF1Q0MsRUFBQUEsUUFBdkM7QUFBaURDLEVBQUFBO0FBQWpELElBQWtFTixPQUFPLENBQUMsWUFBRCxDQUEvRTs7QUFFQSxNQUFNTyxLQUFLLEdBQUdQLE9BQU8sQ0FBQyxTQUFELENBQXJCOztBQVlBLE1BQU1RLE1BQU4sU0FBcUJILFFBQXJCLENBQThCO0FBZTFCSSxFQUFBQSxXQUFXLENBQUNDLE1BQUQsRUFBU0MsSUFBVCxFQUFlQyxTQUFmLEVBQTBCQyxJQUExQixFQUFnQztBQUN2QztBQUR1QyxTQWQzQ0MsT0FjMkMsR0FkakMsSUFBSWYsWUFBSixFQWNpQztBQUFBLFNBUjNDZ0IsTUFRMkMsR0FSbEMsRUFRa0M7QUFPdkMsU0FBS0wsTUFBTCxHQUFjQSxNQUFkO0FBTUEsU0FBS0MsSUFBTCxHQUFZTCxZQUFZLENBQUNLLElBQUQsQ0FBeEI7QUFNQSxTQUFLQyxTQUFMLEdBQWlCQSxTQUFqQjtBQU1BLFNBQUtDLElBQUwsR0FBWUEsSUFBWjtBQUNIOztBQVFERyxFQUFBQSxFQUFF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LEVBQUUsS0FBS0EsUUFKWjtBQUtIZCxNQUFBQSxNQUFNLEVBQUViLENBQUMsQ0FBQ2dHLFNBQUYsQ0FBWSxLQUFLbkYsTUFBakIsRUFBeUJrRCxLQUFLLElBQUlBLEtBQUssQ0FBQ2dDLE1BQU4sRUFBbEMsQ0FMTDtBQU1ITixNQUFBQSxZQUFZLEVBQUUsS0FBS1EsWUFOaEI7QUFPSHpELE1BQUFBLEdBQUcsRUFBRSxLQUFLQSxHQVBQO0FBUUhpQixNQUFBQSxPQUFPLEVBQUUsS0FBS0E7QUFSWCxLQUFQO0FBVUg7O0FBRURsQyxFQUFBQSxRQUFRLENBQUNGLFVBQUQsRUFBYTtBQUNqQm5CLElBQUFBLGNBQWMsQ0FBQ21CLFVBQUQsRUFBYSxJQUFiLEVBQW1CLFVBQW5CLENBQWQ7QUFDQW5CLElBQUFBLGNBQWMsQ0FBQ21CLFVBQUQsRUFBYSxJQUFiLEVBQW1CLFFBQW5CLENBQWQ7QUFDQW5CLElBQUFBLGNBQWMsQ0FBQ21CLFVBQUQsRUFBYSxJQUFiLEVBQW1CLEtBQW5CLENBQWQ7QUFDQW5CLElBQUFBLGNBQWMsQ0FBQ21CLFVBQUQsRUFBYSxJQUFiLEVBQW1CLFNBQW5CLENBQWQ7QUFDSDs7QUExYXlCOztBQTZhOUI2RSxNQUFNLENBQUNDLE9BQVAsR0FBaUI3RixNQUFqQiIsInNvdXJjZXNDb250ZW50IjpbIlwidXNlIHN0cmljdFwiO1xuXG5jb25zdCBFdmVudEVtaXR0ZXIgPSByZXF1aXJlKCdldmVudHMnKTtcbmNvbnN0IHBhdGggPSByZXF1aXJlKCdwYXRoJyk7XG5cbmNvbnN0IHsgXyB9ID0gcmVxdWlyZSgncmstdXRpbHMnKTtcbmNvbnN0IHsgZ2VuZXJhdGVEaXNwbGF5TmFtZSwgZGVlcENsb25lRmllbGQsIENsb25hYmxlLCBlbnRpdHlOYW1pbmcgfSA9IHJlcXVpcmUoJy4vT29sVXRpbHMnKTtcblxuY29uc3QgRmllbGQgPSByZXF1aXJlKCcuL0ZpZWxkJyk7XG5cbi8qKlxuICogRW50aXR5IGV2ZW50IGxpc3RlbmVyXG4gKiBAY2FsbGJhY2sgT29sb25nRW50aXR5LmV2ZW50TGlzdGVuZXJcbiAqIHJldHVybnMgeyp9XG4gKi9cblxuLyoqXG4gKiBPb2xvbmcgZW50aXR5XG4gKiBAY2xhc3MgT29sb25nRW50aXR5XG4gKi9cbmNsYXNzIEVudGl0eSBleHRlbmRzIENsb25hYmxlIHtcbiAgICBfZXZlbnRzID0gbmV3IEV2ZW50RW1pdHRlcigpO1xuXG4gICAgLyoqXG4gICAgICogRmllbGRzIG9mIHRoZSBlbnRpdHksIG1hcCBvZiA8ZmllbGROYW1lLCBmaWVsZE9iamVjdD5cbiAgICAgKiBAbWVtYmVyIHtvYmplY3QuPHN0cmluZywgT29sb25nRmllbGQ+fVxuICAgICAqL1xuICAgIGZpZWxkcyA9IHt9O1xuXG4gICAgLyoqICAgICBcbiAgICAgKiBAcGFyYW0ge0xpbmtlcn0gbGlua2VyXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IG5hbWVcbiAgICAgKiBAcGFyYW0geyp9IG9vbE1vZHVsZVxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBpbmZvXG4gICAgICovXG4gICAgY29uc3RydWN0b3IobGlua2VyLCBuYW1lLCBvb2xNb2R1bGUsIGluZm8pIHtcbiAgICAgICAgc3VwZXIoKTtcblxuICAgICAgICAvKipcbiAgICAgICAgICogTGlua2VyIHRvIHByb2Nlc3MgdGhpcyBlbnRpdHlcbiAgICAgICAgICogQG1lbWJlciB7T29sb25nTGlua2VyfVxuICAgICAgICAgKi9cbiAgICAgICAgdGhpcy5saW5rZXIgPSBsaW5rZXI7XG5cbiAgICAgICAgLyoqXG4gICAgICAgICAqIE5hbWUgb2YgdGhpcyBlbnRpdHlcbiAgICAgICAgICogQG1lbWJlciB7c3RyaW5nfVxuICAgICAgICAgKi9cbiAgICAgICAgdGhpcy5uYW1lID0gZW50aXR5TmFtaW5nKG5hbWUpO1xuXG4gICAgICAgIC8qKlxuICAgICAgICAgKiBPd25lciBvb2xvbmcgbW9kdWxlXG4gICAgICAgICAqIEBtZW1iZXIge29iamVjdH1cbiAgICAgICAgICovXG4gICAgICAgIHRoaXMub29sTW9kdWxlID0gb29sTW9kdWxlO1xuXG4gICAgICAgIC8qKlxuICAgICAgICAgKiBSYXcgbWV0YWRhdGFcbiAgICAgICAgICogQG1lbWJlciB7T2JqZWN0fVxuICAgICAgICAgKi9cbiAgICAgICAgdGhpcy5pbmZvID0gaW5mbzsgICAgICAgIFxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIExpc3RlbiBvbiBhbiBldmVudFxuICAgICAqIEBwYXJhbSB7c3RyaW5nfSBldmVudE5hbWVcbiAgICAgKiBAcGFyYW0ge09vbG9uZ0VudGl0eS5ldmVudExpc3RlbmVyfSBsaXN0ZW5lclxuICAgICAqIEByZXR1cm5zIHtFdmVudEVtaXR0ZXJ9XG4gICAgICovXG4gICAgb24oZXZlbnROYW1lLCBsaXN0ZW5lcikge1xuICAgICAgICByZXR1cm4gdGhpcy5fZXZlbnRzLm9uKGV2ZW50TmFtZSwgbGlzdGVuZXIpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFN0YXJ0IGxpbmtpbmcgdGhpcyBlbnRpdHlcbiAgICAgKiBAcmV0dXJucyB7RW50aXR5fVxuICAgICAqL1xuICAgIGxpbmsoKSB7XG4gICAgICAgIHByZTogIXRoaXMubGlua2VkO1xuXG4gICAgICAgIC8vMS5pbmhlcml0IGZyb20gYmFzZSBlbnRpdHkgaWYgYW55XG4gICAgICAgIC8vMi5pbml0aWFsaXplIGZlYXR1cmVzXG4gICAgICAgIC8vMy5hZGQgZmllbGRzICAgICAgICBcbiAgICAgICAgLy80LmFwaVxuXG4gICAgICAgIC8vaW5kZXhlcyB3aWxsIHByb2Nlc3NlZCBhZnRlciBwcm9jZXNzaW5nIGZvcmVpZ24gcmVsYXRpb25zaGlwXG5cbiAgICAgICAgdGhpcy5saW5rZXIubG9nKCdkZWJ1ZycsICdMaW5raW5nIGVudGl0eSBbJyArIHRoaXMubmFtZSArICddIC4uLicpO1xuXG4gICAgICAgIGlmICh0aGlzLmluZm8uYmFzZSkge1xuICAgICAgICAgICAgLy9pbmhlcml0IGZpZWxkcywgcHJvY2Vzc2VkIGZlYXR1cmVzLCBrZXkgYW5kIGluZGV4ZXNcbiAgICAgICAgICAgIGxldCBiYXNlRW50aXR5ID0gdGhpcy5saW5rZXIubG9hZEVudGl0eSh0aGlzLm9vbE1vZHVsZSwgdGhpcy5pbmZvLmJhc2UpO1xuICAgICAgICAgICAgYXNzZXJ0OiBiYXNlRW50aXR5LmxpbmtlZDtcblxuICAgICAgICAgICAgdGhpcy5faW5oZXJpdChiYXNlRW50aXR5KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICh0aGlzLmluZm8uY29tbWVudCkge1xuICAgICAgICAgICAgLyoqXG4gICAgICAgICAgICAgKiBAbWVtYmVyIHtzdHJpbmd9XG4gICAgICAgICAgICAgKi9cbiAgICAgICAgICAgIHRoaXMuY29tbWVudCA9IHRoaXMuaW5mby5jb21tZW50O1xuICAgICAgICB9XG5cbiAgICAgICAgLyoqXG4gICAgICAgICAqIEBtZW1iZXIge3N0cmluZ31cbiAgICAgICAgICovXG4gICAgICAgIHRoaXMuZGlzcGxheU5hbWUgPSB0aGlzLmNvbW1lbnQgfHwgZ2VuZXJhdGVEaXNwbGF5TmFtZSh0aGlzLm5hbWUpO1xuXG4gICAgICAgIC8qKlxuICAgICAgICAgKiBAZmlyZXMgT29sb25nRW50aXR5I2ZlYXR1cmVzTWl4aW5nSW5cbiAgICAgICAgICovXG4gICAgICAgIHRoaXMuX2V2ZW50cy5lbWl0KCdmZWF0dXJlc01peGluZ0luJyk7XG5cbiAgICAgICAgLy8gbG9hZCBmZWF0dXJlc1xuICAgICAgICBpZiAodGhpcy5pbmZvLmZlYXR1cmVzKSB7XG4gICAgICAgICAgICB0aGlzLmluZm8uZmVhdHVyZXMuZm9yRWFjaChmZWF0dXJlID0+IHtcbiAgICAgICAgICAgICAgICBsZXQgZmVhdHVyZU5hbWU7XG5cbiAgICAgICAgICAgICAgICBpZiAodHlwZW9mIGZlYXR1cmUgPT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgICAgICAgICAgIGZlYXR1cmVOYW1lID0gZmVhdHVyZTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBmZWF0dXJlTmFtZSA9IGZlYXR1cmUubmFtZTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBsZXQgZm4gPSByZXF1aXJlKHBhdGgucmVzb2x2ZShfX2Rpcm5hbWUsIGAuL2VudGl0eUZlYXR1cmVzLyR7ZmVhdHVyZU5hbWV9LmpzYCkpO1xuICAgICAgICAgICAgICAgIGZuKHRoaXMsIHRoaXMubGlua2VyLnRyYW5zbGF0ZU9vbFZhbHVlKHRoaXMub29sTW9kdWxlLCBmZWF0dXJlLmFyZ3MpKTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgLyoqXG4gICAgICAgICAqIEBmaXJlcyBPb2xvbmdFbnRpdHkjYmVmb3JlQWRkaW5nRmllbGRzXG4gICAgICAgICAqL1xuICAgICAgICB0aGlzLl9ldmVudHMuZW1pdCgnYmVmb3JlQWRkaW5nRmllbGRzJyk7XG5cbiAgICAgICAgLy8gcHJvY2VzcyBmaWVsZHNcbiAgICAgICAgaWYgKHRoaXMuaW5mby5maWVsZHMpIHtcbiAgICAgICAgICAgIF8uZWFjaCh0aGlzLmluZm8uZmllbGRzLCAoZmllbGRJbmZvLCBmaWVsZE5hbWUpID0+IHRoaXMuYWRkRmllbGQoZmllbGROYW1lLCBmaWVsZEluZm8pKTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8qKlxuICAgICAgICAgKiBAZmlyZXMgT29sb25nRW50aXR5I2FmdGVyQWRkaW5nRmllbGRzXG4gICAgICAgICAqL1xuICAgICAgICB0aGlzLl9ldmVudHMuZW1pdCgnYWZ0ZXJBZGRpbmdGaWVsZHMnKTsgICBcblxuICAgICAgICBpZiAodGhpcy5pbmZvLmtleSkge1xuICAgICAgICAgICAgdGhpcy5rZXkgPSB0aGlzLmluZm8ua2V5O1xuXG4gICAgICAgICAgICBpZiAoQXJyYXkuaXNBcnJheSh0aGlzLmtleSkgJiYgdGhpcy5rZXkubGVuZ3RoID09PSAxKSB7XG4gICAgICAgICAgICAgICAgdGhpcy5rZXkgPSB0aGlzLmtleVswXTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIC8qKlxuICAgICAgICAgKiBAZmlyZXMgT29sb25nRW50aXR5I2JlZm9yZUFkZGluZ0ludGVyZmFjZXNcbiAgICAgICAgICovXG4gICAgICAgIHRoaXMuX2V2ZW50cy5lbWl0KCdiZWZvcmVBZGRpbmdJbnRlcmZhY2VzJyk7ICAgICAgICBcbiAgICAgICAgXG4gICAgICAgIGlmICghXy5pc0VtcHR5KHRoaXMuaW5mby5pbnRlcmZhY2VzKSkge1xuICAgICAgICAgICAgdGhpcy5pbnRlcmZhY2VzID0gXy5jbG9uZURlZXAodGhpcy5pbmZvLmludGVyZmFjZXMpO1xuXG4gICAgICAgICAgICBfLmZvck93bih0aGlzLmludGVyZmFjZXMsIChpbnRmKSA9PiB7XG4gICAgICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkoaW50Zi5hY2NlcHQpKSB7XG4gICAgICAgICAgICAgICAgICAgIGludGYuYWNjZXB0ID0gXy5tYXAoaW50Zi5hY2NlcHQsIHBhcmFtID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLmxpbmtlci50cmFja0JhY2tUeXBlKHRoaXMub29sTW9kdWxlLCBwYXJhbSk7XG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgLyoqXG4gICAgICAgICAqIEBmaXJlcyBPb2xvbmdFbnRpdHkjYWZ0ZXJBZGRpbmdJbnRlcmZhY2VzXG4gICAgICAgICAqL1xuICAgICAgICB0aGlzLl9ldmVudHMuZW1pdCgnYWZ0ZXJBZGRpbmdJbnRlcmZhY2VzJyk7ICAgICAgICBcblxuICAgICAgICB0aGlzLmxpbmtlZCA9IHRydWU7XG5cbiAgICAgICAgcmV0dXJuIHRoaXM7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQ2hlY2sgd2hldGhlciB0aGUgZW50aXR5IGhhcyBhbiBpbmRleCBvbiB0aGUgZ2l2ZW4gZmllbGRzXG4gICAgICogQHBhcmFtIHthcnJheX0gZmllbGRzXG4gICAgICogQHJldHVybnMge2Jvb2xlYW59XG4gICAgICovXG4gICAgaGFzSW5kZXhPbihmaWVsZHMpIHtcbiAgICAgICAgZmllbGRzID0gZmllbGRzLmNvbmNhdCgpO1xuICAgICAgICBmaWVsZHMuc29ydCgpO1xuXG4gICAgICAgIHJldHVybiBfLmZpbmRJbmRleCh0aGlzLmluZGV4ZXMsIGluZGV4ID0+IHtcbiAgICAgICAgICAgICAgICByZXR1cm4gXy5maW5kSW5kZXgoaW5kZXguZmllbGRzLCAoZiwgaWR4KSA9PiAoZmllbGRzLmxlbmd0aCA8PSBpZHggfHwgZmllbGRzW2lkeF0gIT09IGYpKSA9PT0gLTE7XG4gICAgICAgICAgICB9KSAhPSAtMTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBBZGQgYWxsIGluZGV4ZXNcbiAgICAgKi9cbiAgICBhZGRJbmRleGVzKCkge1xuICAgICAgICBpZiAodGhpcy5pbmZvLmluZGV4ZXMpIHtcbiAgICAgICAgICAgIF8uZWFjaCh0aGlzLmluZm8uaW5kZXhlcywgaW5kZXggPT4ge1xuICAgICAgICAgICAgICAgIHRoaXMuYWRkSW5kZXgoaW5kZXgpO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBBZGQgYW4gaW5kZXhcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gaW5kZXhcbiAgICAgKiBAcHJvcGVydHkge2FycmF5fSBpbmRleC5maWVsZHMgLSBGaWVsZHMgb2YgdGhlIGluZGV4XG4gICAgICogQHByb3BlcnR5IHtib29sfSBpbmRleC51bmlxdWUgLSBGbGFnIG9mIHVuaXF1ZW5lc3Mgb2YgdGhlIGluZGV4XG4gICAgICogQHJldHVybnMge0VudGl0eX1cbiAgICAgKi9cbiAgICBhZGRJbmRleChpbmRleCkge1xuICAgICAgICBpZiAoIXRoaXMuaW5kZXhlcykge1xuICAgICAgICAgICAgdGhpcy5pbmRleGVzID0gW107XG4gICAgICAgIH1cblxuICAgICAgICBpbmRleCA9IF8uY2xvbmVEZWVwKGluZGV4KTtcblxuICAgICAgICBhc3NlcnQ6IGluZGV4LmZpZWxkcztcblxuICAgICAgICBpZiAoIV8uaXNBcnJheShpbmRleC5maWVsZHMpKSB7XG4gICAgICAgICAgICBpbmRleC5maWVsZHMgPSBbIGluZGV4LmZpZWxkcyBdO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGZpZWxkcyA9IGluZGV4LmZpZWxkczsgXG5cbiAgICAgICAgaW5kZXguZmllbGRzID0gXy5tYXAoZmllbGRzLCBmaWVsZCA9PiB7XG5cbiAgICAgICAgICAgIGxldCBub3JtYWxpemVkRmllbGQgPSBfLmNhbWVsQ2FzZShmaWVsZCk7XG5cbiAgICAgICAgICAgIGlmICghdGhpcy5oYXNGaWVsZChub3JtYWxpemVkRmllbGQpKSB7XG5cbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEluZGV4IHJlZmVyZW5jZXMgbm9uLWV4aXN0IGZpZWxkOiAke2ZpZWxkfSwgZW50aXR5OiAke3RoaXMubmFtZX0uYCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiBub3JtYWxpemVkRmllbGQ7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIGluZGV4LmZpZWxkcy5zb3J0KCk7XG5cbiAgICAgICAgaWYgKHRoaXMuaGFzSW5kZXhPbihpbmRleC5maWVsZHMpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEluZGV4IG9uIFske2luZGV4LmZpZWxkcy5qb2luKCcsICcpfV0gYWxyZWFkeSBleGlzdCBpbiBlbnRpdHkgWyR7dGhpcy5uYW1lfV0uYCk7XG4gICAgICAgIH1cblxuICAgICAgICB0aGlzLmluZGV4ZXMucHVzaChpbmRleCk7XG5cbiAgICAgICAgcmV0dXJuIHRoaXM7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogR2V0IGEgZmllbGQgb2JqZWN0IGJ5IGZpZWxkIG5hbWUgb3IgZmllbGQgYWNjZXNvci5cbiAgICAgKiBAcGFyYW0gZmllbGRJZFxuICAgICAqIEByZXR1cm5zIHtPb2xvbmdGaWVsZH1cbiAgICAgKi9cbiAgICBnZXRFbnRpdHlBdHRyaWJ1dGUoZmllbGRJZCkge1xuICAgICAgICBpZiAoZmllbGRJZFswXSA9PT0gJyQnKSB7XG4gICAgICAgICAgICBsZXQgdG9rZW4gPSBmaWVsZElkLnN1YnN0cigxKTtcblxuICAgICAgICAgICAgc3dpdGNoICh0b2tlbikge1xuICAgICAgICAgICAgICAgIGNhc2UgXCJrZXlcIjpcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuZmllbGRzW3RoaXMua2V5XTtcblxuICAgICAgICAgICAgICAgIGNhc2UgJ2ZlYXR1cmUnOlxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5mZWF0dXJlcztcblxuICAgICAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgRmlsZWQgYWNjZXNzb3IgXCIke3Rva2VufVwiIG5vdCBzdXBwb3J0ZWQhYCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBpZiAoIXRoaXMuaGFzRmllbGQoZmllbGRJZCkpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEZpZWxkIFwiJHtmaWVsZElkfVwiIG5vdCBleGlzdHMgaW4gZW50aXR5IFwiJHt0aGlzLm5hbWV9XCIuYClcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIHRoaXMuZmllbGRzW2ZpZWxkSWRdO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQ2hlY2sgd2hldGhlciB0aGUgZW50aXR5IGhhcyBhIGZpZWxkIHdpdGggZ2l2ZW4gbmFtZVxuICAgICAqIEBwYXJhbSB7c3RyaW5nfSBuYW1lXG4gICAgICogQHJldHVybnMge2Jvb2xlYW59XG4gICAgICovXG4gICAgaGFzRmllbGQobmFtZSkge1xuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShuYW1lKSkge1xuICAgICAgICAgICAgcmV0dXJuIF8uZXZlcnkobmFtZSwgZm4gPT4gdGhpcy5oYXNGaWVsZChmbikpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIG5hbWUgaW4gdGhpcy5maWVsZHM7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQWRkIGEgYXNzb2NpYXRpb24gZmllbGQuXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IG5hbWVcbiAgICAgKiBAcGFyYW0ge09vbG9uZ0VudGl0eX0gZGVzdEVudGl0eVxuICAgICAqIEBwYXJhbSB7T29sb25nRmllbGR9IGRlc3RGaWVsZFxuICAgICAqL1xuICAgIGFkZEFzc29jRmllbGQobmFtZSwgZGVzdEVudGl0eSwgZGVzdEZpZWxkKSB7XG4gICAgICAgIGxldCBsb2NhbEZpZWxkID0gdGhpcy5maWVsZHNbbmFtZV07XG5cbiAgICAgICAgaWYgKGxvY2FsRmllbGQpIHtcbiAgICAgICAgICAgIC8qXG4gICAgICAgICAgICBpZiAoIWxvY2FsRmllbGQuaGFzU2FtZVR5cGUoZGVzdEZpZWxkLnRvSlNPTigpKSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgVGhlIHR5cGUgb2Ygc291cmNlIGZpZWxkIFwiJHt0aGlzLm5hbWV9LiR7bmFtZX1cIiBpcyBkaWZmZXJlbnQgZnJvbSB0aGUgcmVmZXJlbmNlZCBmaWVsZCBcIiR7ZGVzdEVudGl0eS5uYW1lfS4ke2Rlc3RGaWVsZC5uYW1lfVwiLmApO1xuICAgICAgICAgICAgfSovXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEZpZWxkIFwiJHtuYW1lfVwiIGFscmVhZHkgZXhpc3RzIGluIGVudGl0eSBcIiR7dGhpcy5uYW1lfVwiLmApO1xuICAgICAgICAgICAgLy9yZXR1cm47XG4gICAgICAgIH1cblxuICAgICAgICB0aGlzLmFkZEZpZWxkKG5hbWUsIGRlc3RGaWVsZCk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQWRkIGEgZmllbGQgaW50byB0aGUgZW50aXR5XG4gICAgICogQHBhcmFtIHtzdHJpbmd9IG5hbWVcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gcmF3SW5mb1xuICAgICAqIEByZXR1cm5zIHtFbnRpdHl9XG4gICAgICovXG4gICAgYWRkRmllbGQobmFtZSwgcmF3SW5mbykgeyAgICAgICAgXG4gICAgICAgIGlmICh0aGlzLmhhc0ZpZWxkKG5hbWUpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEZpZWxkIG5hbWUgWyR7bmFtZX1dIGNvbmZsaWN0cyBpbiBlbnRpdHkgWyR7dGhpcy5uYW1lfV0uYCk7XG4gICAgICAgIH1cblxuICAgICAgICBhc3NlcnQ6IHJhd0luZm8udHlwZTtcblxuICAgICAgICBsZXQgZmllbGQ7XG5cbiAgICAgICAgaWYgKHJhd0luZm8gaW5zdGFuY2VvZiBGaWVsZCkge1xuICAgICAgICAgICAgZmllbGQgPSByYXdJbmZvLmNsb25lKCk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBsZXQgZnVsbFJhd0luZm8gPSB0aGlzLmxpbmtlci50cmFja0JhY2tUeXBlKHRoaXMub29sTW9kdWxlLCByYXdJbmZvKTtcblxuICAgICAgICAgICAgZmllbGQgPSBuZXcgRmllbGQobmFtZSwgZnVsbFJhd0luZm8pO1xuICAgICAgICAgICAgZmllbGQubGluaygpO1xuICAgICAgICB9ICAgICAgICBcbiAgICAgICAgXG4gICAgICAgIHRoaXMuZmllbGRzW25hbWVdID0gZmllbGQ7XG5cbiAgICAgICAgaWYgKCF0aGlzLmtleSkge1xuICAgICAgICAgICAgLy9tYWtlIHRoZSBmaXJzdCBmaWVsZCBhcyB0aGUgZGVmYXVsdCBrZXlcbiAgICAgICAgICAgIHRoaXMua2V5ID0gbmFtZTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB0aGlzO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEFkZCBhIGZlYXR1cmUgaW50byB0aGUgZW50aXR5LCBlLmcuIGF1dG8gaW5jcmVtZW50IGlkXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IG5hbWVcbiAgICAgKiBAcGFyYW0geyp9IGZlYXR1cmVcbiAgICAgKiBAcGFyYW0ge2Jvb2x9IFthbGxvd011bHRpcGxlPWZhbHNlXSAtIEFsbG93IG11bHRpcGxlIG9jY3VycmVuY2VcbiAgICAgKiBAcmV0dXJucyB7RW50aXR5fVxuICAgICAqL1xuICAgIGFkZEZlYXR1cmUobmFtZSwgZmVhdHVyZSwgYWxsb3dNdWx0aXBsZSkge1xuICAgICAgICBpZiAoIXRoaXMuZmVhdHVyZXMpIHtcbiAgICAgICAgICAgIHRoaXMuZmVhdHVyZXMgPSB7fTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChhbGxvd011bHRpcGxlKSB7XG4gICAgICAgICAgICBpZiAoIXRoaXMuZmVhdHVyZXNbbmFtZV0pIHtcbiAgICAgICAgICAgICAgICB0aGlzLmZlYXR1cmVzW25hbWVdID0gW107XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHRoaXMuZmVhdHVyZXNbbmFtZV0ucHVzaChmZWF0dXJlKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGlmIChmZWF0dXJlLm5hbWUgaW4gdGhpcy5mZWF0dXJlcykge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgRHVwbGljYXRlIGZlYXR1cmUgZm91bmQ6ICR7bmFtZX0uIFR1cm4gb24gYWxsb3dNdWx0aXBsZSB0byBlbmFibGUgbXVsdGlwbGUgb2NjdXJyZW5jZSBvZiBhIGZlYXR1cmUuYCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHRoaXMuZmVhdHVyZXNbbmFtZV0gPSBmZWF0dXJlO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHRoaXM7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogU2V0IGtleSBuYW1lXG4gICAgICogQHBhcmFtIHtzdHJpbmd8YXJyYXkuPHN0cmluZz59IG5hbWUgLSBGaWVsZCBuYW1lIHRvIGJlIHVzZWQgYXMgdGhlIGtleVxuICAgICAqIEByZXR1cm5zIHtFbnRpdHl9XG4gICAgICovXG4gICAgc2V0S2V5KG5hbWUpIHtcbiAgICAgICAgdGhpcy5rZXkgPSBuYW1lO1xuICAgICAgICByZXR1cm4gdGhpcztcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBSZXR1cm5zIHRoZSBhc3NvY2lhdGlvbiBpbmZvIGlmIHRoZXJlIGlzIGNvbm5lY3Rpb24gdG8gdGhlIGdpdmVuIGRlc3RpbmF0aW9uIGVudGl0eS5cbiAgICAgKi9cbiAgICBnZXRSZWZlcmVuY2VUbyhlbnRpdHlOYW1lLCBjb25uZWN0ZWRCeSkge1xuICAgICAgICByZXR1cm4gdGhpcy5pbmZvLmFzc29jaWF0aW9ucyAmJiBfLmZpbmQodGhpcy5pbmZvLmFzc29jaWF0aW9ucywgYXNzb2MgPT4gYXNzb2MuZGVzdEVudGl0eSA9PT0gZW50aXR5TmFtZSAmJiBjb25uZWN0ZWRCeSA9PT0gYXNzb2MuY29ubmVjdGVkQnkpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEdldCBrZXkgZmllbGQgXG4gICAgICogQHJldHVybnMgeyp9XG4gICAgICovXG4gICAgZ2V0S2V5RmllbGQoKSB7XG4gICAgICAgIHJldHVybiBBcnJheS5pc0FycmF5KHRoaXMua2V5KSA/IHRoaXMua2V5Lm1hcChrZiA9PiB0aGlzLmZpZWxkc1trZl0pIDogdGhpcy5maWVsZHNbdGhpcy5rZXldO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIENsb25lIHRoZSBlbnRpdHlcbiAgICAgKiBAcGFyYW0ge01hcH0gW3N0YWNrXSAtIFJlZmVyZW5jZSBzdGFjayB0byBhdm9pZCByZWN1cnJlbmNlIGNvcHlcbiAgICAgKiBAcmV0dXJucyB7RW50aXR5fVxuICAgICAqL1xuICAgIGNsb25lKCkgeyAgICAgICAgXG4gICAgICAgIHN1cGVyLmNsb25lKCk7XG5cbiAgICAgICAgbGV0IGVudGl0eSA9IG5ldyBFbnRpdHkodGhpcy5saW5rZXIsIHRoaXMubmFtZSwgdGhpcy5vb2xNb2R1bGUsIHRoaXMuaW5mbyk7ICAgICAgICBcblxuICAgICAgICBkZWVwQ2xvbmVGaWVsZCh0aGlzLCBlbnRpdHksICdkaXNwbGF5TmFtZScpO1xuICAgICAgICBkZWVwQ2xvbmVGaWVsZCh0aGlzLCBlbnRpdHksICdjb21tZW50Jyk7XG4gICAgICAgIGRlZXBDbG9uZUZpZWxkKHRoaXMsIGVudGl0eSwgJ2ZlYXR1cmVzJyk7XG4gICAgICAgIGRlZXBDbG9uZUZpZWxkKHRoaXMsIGVudGl0eSwgJ2ZpZWxkcycpOyAgICBcbiAgICAgICAgZGVlcENsb25lRmllbGQodGhpcywgZW50aXR5LCAnYWNjb2NpYXRpb25zJyk7ICAgICAgICBcbiAgICAgICAgZGVlcENsb25lRmllbGQodGhpcywgZW50aXR5LCAna2V5Jyk7ICAgICAgICBcbiAgICAgICAgZGVlcENsb25lRmllbGQodGhpcywgZW50aXR5LCAnaW5kZXhlcycpOyAgICAgICAgXG4gICAgICAgIGRlZXBDbG9uZUZpZWxkKHRoaXMsIGVudGl0eSwgJ2ludGVyZmFjZXMnKTtcblxuICAgICAgICBlbnRpdHkubGlua2VkID0gdHJ1ZTtcblxuICAgICAgICByZXR1cm4gZW50aXR5O1xuICAgIH1cbiBcbiAgICAvKipcbiAgICAgKiBUcmFuc2xhdGUgdGhlIGVudGl0eSBpbnRvIGEgcGxhaW4gSlNPTiBvYmplY3RcbiAgICAgKiBAcmV0dXJucyB7b2JqZWN0fVxuICAgICAqL1xuICAgIHRvSlNPTigpIHtcbiAgICAgICAgcmV0dXJuIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIG5hbWU6IHRoaXMubmFtZSxcbiAgICAgICAgICAgIGRpc3BsYXlOYW1lOiB0aGlzLmRpc3BsYXlOYW1lLFxuICAgICAgICAgICAgY29tbWVudDogdGhpcy5jb21tZW50LCAgICAgICAgICAgIFxuICAgICAgICAgICAgZmVhdHVyZXM6IHRoaXMuZmVhdHVyZXMsICAgICAgICAgICAgXG4gICAgICAgICAgICBmaWVsZHM6IF8ubWFwVmFsdWVzKHRoaXMuZmllbGRzLCBmaWVsZCA9PiBmaWVsZC50b0pTT04oKSksXG4gICAgICAgICAgICBhc3NvY2lhdGlvbnM6IHRoaXMuYWNjb2NpYXRpb25zLFxuICAgICAgICAgICAga2V5OiB0aGlzLmtleSxcbiAgICAgICAgICAgIGluZGV4ZXM6IHRoaXMuaW5kZXhlc1xuICAgICAgICB9O1xuICAgIH1cblxuICAgIF9pbmhlcml0KGJhc2VFbnRpdHkpIHsgICAgICAgIFxuICAgICAgICBkZWVwQ2xvbmVGaWVsZChiYXNlRW50aXR5LCB0aGlzLCAnZmVhdHVyZXMnKTtcbiAgICAgICAgZGVlcENsb25lRmllbGQoYmFzZUVudGl0eSwgdGhpcywgJ2ZpZWxkcycpO1xuICAgICAgICBkZWVwQ2xvbmVGaWVsZChiYXNlRW50aXR5LCB0aGlzLCAna2V5Jyk7ICAgICAgICBcbiAgICAgICAgZGVlcENsb25lRmllbGQoYmFzZUVudGl0eSwgdGhpcywgJ2luZGV4ZXMnKTtcbiAgICB9XG59XG5cbm1vZHVsZS5leHBvcnRzID0gRW50aXR5OyJdfQ==