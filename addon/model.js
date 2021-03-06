import Ember from 'ember';
import { RootState } from 'ember-data/-private';
import { dasherize } from '@ember/string';

import M3ModelData from './model-data';
import SchemaManager from './schema-manager';
import M3RecordArray from './record-array';
import { OWNER_KEY } from './util';

const { get, set, propertyWillChange, propertyDidChange, computed, A } = Ember;

const { deleted: { uncommitted: deletedUncommitted }, loaded: { saved: loadedSaved } } = RootState;

class EmbeddedSnapshot {
  constructor(record) {
    this.record = record;
    this.modelName = this.record._internalModel.modelName;
    this.attrs = Object.create(null);
    this.eachAttribute(key => (this.attrs[key] = this.record.get(key)));
  }

  serialize(options) {
    return this.record._store.serializerFor('-ember-m3').serialize(this, options);
  }

  eachAttribute(callback, binding) {
    return this.record.eachAttribute(callback, binding);
  }

  attr(key) {
    return this.attrs[key];
  }
}

class EmbeddedInternalModel {
  constructor({ id, modelName, attributes, store, parentInternalModel }) {
    this.id = id;
    this.modelName = modelName;

    this._modelData = new M3ModelData(
      modelName,
      id,
      null,
      parentInternalModel._modelData.storeWrapper,
      store,
      this
    );
    this._modelData.pushData({
      attributes,
    });
    this.store = store;
    this.parentInternalModel = parentInternalModel;

    this.record = null;
  }

  createSnapshot() {
    return new EmbeddedSnapshot(this.record);
  }
}

function resolveReference(reference, store) {
  if (reference.type === null) {
    // for schemas with a global id-space but multiple types, schemas may
    // report a type of null
    let internalModel = store._globalM3Cache[reference.id];
    return internalModel ? internalModel.getRecord() : null;
  } else {
    // respect the user schema's type if provided
    return store.peekRecord(reference.type, reference.id);
  }
}

function resolveValue(key, value, modelName, store, schema, model) {
  const schemaInterface = model._internalModel._modelData.schemaInterface;

  if (schema.isAttributeArrayReference(key, value, modelName, schemaInterface)) {
    return resolveRecordArray(key, value, modelName, store, schema, schemaInterface);
  }

  // TODO: remove this and instead just have computeAttributeReference return an array of refs
  if (Array.isArray(value)) {
    return resolvePlainArray(key, value, modelName, store, schema, model, schemaInterface);
  }

  let reference = schema.computeAttributeReference(key, value, modelName, schemaInterface);

  if (reference !== undefined && reference !== null) {
    if (Array.isArray(reference)) {
      return reference.map(singleRef => resolveReference(singleRef, store));
    } else {
      return resolveReference(reference, store);
    }
  }

  let nested = schema.computeNestedModel(key, value, modelName, schemaInterface);
  if (nested) {
    let internalModel = new EmbeddedInternalModel({
      id: nested.id,
      // maintain consistency with internalmodel.modelName, which is normalized
      // internally within ember-data
      modelName: nested.type ? dasherize(nested.type) : null,
      attributes: nested.attributes,
      store,
      parentInternalModel: model._internalModel,
    });
    let nestedModel = new EmbeddedMegamorphicModel({
      store,
      _internalModel: internalModel,
      _parentModel: model,
      _topModel: model._topModel,
    });
    internalModel.record = nestedModel;

    return nestedModel;
  }

  return value;
}

function resolvePlainArray(key, value, modelName, store, schema, model, schemaInterface) {
  if (value == null) {
    return new Array(0);
  }

  let result = new Array(value.length);

  for (let i = 0; i < value.length; ++i) {
    result[i] = resolveValue(key, value[i], modelName, store, schema, model, schemaInterface, i);
  }

  return result;
}

function resolveRecordArray(key, value, modelName, store, schema, schemaInterface) {
  let recordArrayManager = store._recordArrayManager;

  let array = M3RecordArray.create({
    modelName: '-ember-m3',
    content: Ember.A(),
    store: store,
    manager: recordArrayManager,
  });

  let internalModels = resolveRecordArrayInternalModels(
    key,
    value,
    modelName,
    store,
    schema,
    schemaInterface
  );

  array._setInternalModels(internalModels);

  return array;
}

function resolveRecordArrayInternalModels(key, value, modelName, store, schema, schemaInterface) {
  // TODO: mention in UPGRADING.md
  let reference = schema.computeAttributeReference(key, value, modelName, schemaInterface);
  if (reference === undefined || reference === null) {
    reference = [];
  }
  let internalModels = new Array(reference.length);

  for (let i = 0; i < internalModels.length; ++i) {
    let singleRef = reference[i];
    if (singleRef.type) {
      // for schemas with a global id-space but multiple types, schemas may
      // report a type of null
      internalModels[i] = store._internalModelForId(singleRef.type, singleRef.id);
    } else {
      internalModels[i] = store._globalM3Cache[singleRef.id];
    }
  }

  return internalModels;
}

function disallowAliasSet(object, key, value) {
  throw new Error(
    `You tried to set '${key}' to '${value}', but '${key}' is an alias in '${
      object._modelName
    }' and aliases are read-only`
  );
}

class YesManAttributesSingletonClass {
  has() {
    return true;
  }

  // This stub exists for the inspector
  forEach(/* cb */) {
    // cb(meta, name)
    return;
  }
}

const YesManAttributes = new YesManAttributesSingletonClass();

const retrieveFromCurrentState = computed('currentState', function(key) {
  return this._topModel._internalModel.currentState[key];
}).readOnly();

// global buffer for initial properties to work around
//  a)  can't write to `this` before `super`
//  b)  core_object writes properties before calling `init`; this means that no
//      CP or setknownProperty can rely on any initialization
let initProperites = Object.create(null);

export default class MegamorphicModel extends Ember.Object {
  init(properties) {
    // Drop Ember.Object subclassing instead
    super.init(...arguments);
    this._store = properties.store;
    this._internalModel = properties._internalModel;
    this._cache = Object.create(null);
    this._schema = SchemaManager;

    this._topModel = this._topModel || this;
    this._parentModel = this._parentModel || null;
    this._init = true;

    this._flushInitProperties();
  }

  _flushInitProperties() {
    let propertiesToFlush = initProperites;
    initProperites = Object.create(null);

    let keys = Object.keys(propertiesToFlush);
    if (keys.length > 0) {
      for (let i = 0; i < keys.length; ++i) {
        let key = keys[i];
        let value = propertiesToFlush[key];
        this.setUnknownProperty(key, value);
      }
    }
  }

  static get isModel() {
    return true;
  }

  static get klass() {
    return MegamorphicModel;
  }

  static get attributes() {
    return YesManAttributes;
  }

  static eachRelationship(/* callback */) {}

  static create(properties) {
    return new this(properties);
  }

  get _modelName() {
    return this._internalModel.modelName;
  }

  __defineNonEnumerable(property) {
    this[property.name] = property.descriptor.value;
  }

  _notifyProperties(keys) {
    Ember.beginPropertyChanges();
    let key;
    for (let i = 0, length = keys.length; i < length; i++) {
      key = keys[i];
      let oldValue = this._cache[key];
      let newValue = this._internalModel._modelData.getAttr(key);

      let oldIsRecordArray = oldValue && oldValue instanceof M3RecordArray;
      let oldWasModel = oldValue && oldValue instanceof MegamorphicModel;
      let newIsObject = typeof newValue === 'object';

      if (oldWasModel && newIsObject) {
        oldValue._didReceiveNestedProperties(this._internalModel._modelData.getAttr(key));
      } else if (oldIsRecordArray) {
        let internalModels = resolveRecordArrayInternalModels(
          key,
          newValue,
          this._modelName,
          this._store,
          this._schema
        );
        oldValue._setInternalModels(internalModels);
      } else {
        // anything -> undefined | primitive
        delete this._cache[key];
        this.notifyPropertyChange(key);
      }
    }
    Ember.endPropertyChanges();
  }

  _didReceiveNestedProperties(data) {
    let changedKeys = this._internalModel._modelData.pushData({ attributes: data }, true);
    if (changedKeys.length > 0) {
      this._notifyProperties(changedKeys);
    }
  }

  changedAttributes() {
    // TODO: this will always report nothing has changed; bc we just `set` to
    // `_data` and don't make a data/attributes distinction.  We coooould, if
    // serializers actually need to know changed attrs.
    return this._internalModel.changedAttributes();
  }

  trigger() {}

  get _debugContainerKey() {
    return 'MegamorphicModel';
  }

  debugJSON() {
    return this._internalModel._modelData._data;
  }

  eachAttribute(callback, binding) {
    if (!this._internalModel._modelData._data) {
      // see #14
      return;
    }

    // Properties in `data` are treated as attributes for serialization purposes
    // if the schema does not consider them references
    Object.keys(this._internalModel._modelData._data).forEach(callback, binding);
  }

  unloadRecord() {
    // can't call unloadRecord on nested m3 models
    this._internalModel.unloadRecord();
    this._store._queryCache.unloadRecord(this);
  }

  set(key, value) {
    set(this, key, value);
  }

  serialize(options) {
    return this._internalModel.createSnapshot().serialize(options);
  }

  toJSON() {
    return this.serialize();
  }

  save(options) {
    // TODO: we could return a PromiseObject as DS.Model does
    return this._internalModel.save(options).then(() => this);
  }

  reload(options = {}) {
    // passing in options here is something you can't actually do with DS.Model
    // but there isn't a good reason for this; that support should be added in
    // ember-data
    options.reload = true;
    return this._store.findRecord(this._modelName, this.id, options);
  }

  deleteRecord() {
    this._internalModel.currentState = deletedUncommitted;
    propertyDidChange(this, 'currentState');
  }

  destroyRecord(options) {
    this.deleteRecord();
    return this._internalModel.save(options);
  }

  rollbackAttributes() {
    // TODO: we could actually support this feature
    this._internalModel.currentState = loadedSaved;
    propertyDidChange(this, 'currentState');
  }

  unknownProperty(key) {
    if (key in this._cache) {
      return this._cache[key];
    }

    if (!this._schema.isAttributeIncluded(this._modelName, key)) {
      return;
    }

    let rawValue = this._internalModel._modelData.getAttr(key);
    // TODO IGOR DAVID
    // figure out if any of the below should be moved into model data
    if (rawValue === undefined) {
      let alias = this._schema.getAttributeAlias(this._modelName, key);
      if (alias) {
        const cp = Ember.computed.alias(alias);
        cp.set = disallowAliasSet;
        this[key] = cp;
        return cp.get(this, key);
      }

      let defaultValue = this._schema.getDefaultValue(this._modelName, key);

      // If default value is not defined, resolve the key for reference
      if (defaultValue !== undefined) {
        return (this._cache[key] = defaultValue);
      }
    }

    let value = this._schema.transformValue(this._modelName, key, rawValue);
    return (this._cache[key] = resolveValue(
      key,
      value,
      this._modelName,
      this._store,
      this._schema,
      this
    ));
  }

  get id() {
    return this._internalModel.id;
  }

  set id(value) {
    if (!this._init) {
      this._internalModel.id = value;
      return;
    }

    throw new Error(
      `You tried to set 'id' to '${value}' for '${
        this._modelName
      }' but records can only set their ID by providing it to store.createRecord()`
    );
  }

  // TODO: drop change events for unretrieved properties
  setUnknownProperty(key, value) {
    if (key === OWNER_KEY) {
      // 2.12 support; later versions avoid this call entirely
      return;
    }

    if (!this._init) {
      initProperites[key] = value;
      return;
    }

    if (this._schema.getAttributeAlias(this._modelName, key)) {
      throw new Error(
        `You tried to set '${key}' to '${value}', but '${key}' is an alias in '${
          this._modelName
        }' and aliases are read-only`
      );
    }

    propertyWillChange(this, key);

    // TODO: need to be able to update relationships
    // TODO: also on set(x) ask schema if this should be a ref (eg if it has an
    // entityUrn)
    // TODO: similarly this.get('arr').pushObject doesn't update the underlying
    // _data
    if (
      // TODO: check if we have a new value here
      // TODO: maybe we can computeAttributeArrayRef here
      this._schema.isAttributeArrayReference(
        key,
        value,
        this._modelName,
        this._internalModel._modelData.schemaInterface
      )
    ) {
      this._setRecordArray(key, value);
    } else {
      this._internalModel._modelData.setAttr(key, value);
      delete this._cache[key];
    }

    propertyDidChange(this, key);
  }

  _setRecordArray(key, models) {
    // TODO Should we add support for array proxy as well
    let ids = new Array(models.length);
    models = A(models);
    for (let i = 0; i < ids.length; ++i) {
      // TODO: should have a schema hook for this
      ids[i] = get(models.objectAt(i), 'id');
    }
    this._internalModel._modelData.setAttr(key, ids);

    if (key in this._cache) {
      let recordArray = this._cache[key];
      recordArray.replaceContent(0, get(recordArray, 'length'), models);
    }
  }

  static toString() {
    return 'MegamorphicModel';
  }

  toString() {
    return `<MegamorphicModel:${this.id}>`;
  }
}

MegamorphicModel.prototype.store = null;
MegamorphicModel.prototype._internalModel = null;
MegamorphicModel.prototype._parentModel = null;
MegamorphicModel.prototype._topModel = null;
MegamorphicModel.prototype.currentState = null;
MegamorphicModel.prototype.isError = null;
MegamorphicModel.prototype.adapterError = null;

MegamorphicModel.relationshipsByName = new Ember.Map();

// STATE PROPS
MegamorphicModel.prototype.isEmpty = retrieveFromCurrentState;
MegamorphicModel.prototype.isLoading = retrieveFromCurrentState;
MegamorphicModel.prototype.isLoaded = retrieveFromCurrentState;
MegamorphicModel.prototype.isSaving = retrieveFromCurrentState;
MegamorphicModel.prototype.isDeleted = retrieveFromCurrentState;
MegamorphicModel.prototype.isNew = retrieveFromCurrentState;
MegamorphicModel.prototype.isValid = retrieveFromCurrentState;
MegamorphicModel.prototype.dirtyType = retrieveFromCurrentState;

class EmbeddedMegamorphicModel extends MegamorphicModel {
  unloadRecord() {
    Ember.warn(
      `Nested models cannot be directly unloaded.  Perhaps you meant to unload the top level model, '${
        this._topModel._modelName
      }:${this._topModel.id}'`,
      false,
      { id: 'ember-m3.nested-model-unloadRecord' }
    );
  }

  // no special behaviour for ids of embedded/nested models

  get id() {
    return this.unknownProperty('id');
  }

  set id(value) {
    return this.setUnknownProperty('id', value);
  }
}
