import { isEqual } from '@ember/utils';
import { assign, merge } from '@ember/polyfills';
import { copy } from '@ember/object/internals';
import { assert } from '@ember/debug';
import { dasherize } from '@ember/string';
import { isNone } from '@ember/utils';

import { coerceId } from 'ember-data/-private';
import Ember from 'ember';

import SchemaManager from './schema-manager';

const emberAssign = assign || merge;

function pushDataAndNotify(modelData, updates) {
  let changedKeys = modelData.pushData({ attributes: updates });

  modelData._notifyRecordProperties(changedKeys);
}

function commitDataAndNotify(modelData, updates) {
  let changedKeys = modelData.didCommit({ attributes: updates });

  modelData._notifyRecordProperties(changedKeys);
}

class NestedModelDataWrapper {
  constructor(nestedInternalModel) {
    this.internalModel = nestedInternalModel;
  }

  notifyPropertyChange(modelName, id, clientId, key) {
    // TODO enhance this assert
    assert('TODO', modelName === this.internalModel.modelName && id === this.internalModel.id);

    if (this.internalModel.hasRecord) {
      this.internalModel._record.notifyPropertyChange(key);
    }
  }
}

export default class M3ModelData {
  constructor(modelName, id, clientId, storeWrapper, store) {
    this.store = store;
    this.modelName = modelName;
    this.clientId = clientId;
    this.id = id;
    this.storeWrapper = storeWrapper;
    this._schema = SchemaManager;
    this.isDestroyed = false;
    this.reset();

    this.baseModelName = this._schema.computeBaseModelName(this.modelName);

    // TODO we may not have ID yet?
    this.__projections = null;

    if (this.baseModelName && this.id) {
      // TODO we may not have ID yet?
      this._initBaseModelData(this.baseModelName, id);
    } else {
      this.baseModelData = null;
    }
  }

  // PUBLIC API

  getResourceIdentifier() {
    return {
      id: this.id,
      type: this.modelName,
      clientId: this.clientId,
    };
  }

  pushData(data, calculateChange) {
    if (!calculateChange) {
      // check whether we have projections, which will require notifications
      calculateChange = this._projections && this._projections.length > 0;
    }
    let changedKeys = this._mergeUpdates(data.attributes, pushDataAndNotify, calculateChange);

    if (this.__attributes) {
      // only do if we have attribute changes
      this._updateChangedAttributes();
    }

    if (calculateChange) {
      this._notifyProjectionProperties(changedKeys);
    }

    if (data.id) {
      this.id = coerceId(data.id);
    }

    return changedKeys;
  }

  willCommit() {
    // TODO Iterate over nested models as well
    this._inFlightAttributes = this._attributes;
    this._attributes = null;
  }

  hasChangedAttributes() {
    return this.__attributes !== null && Object.keys(this.__attributes).length > 0;
  }

  reset() {
    this.__data = null;
    this.__attributes = null;
    this.__inFlightAttributes = null;
    this.__nestedModelsData = null;
  }

  addToHasMany() {}

  removeFromHasMany() {}

  /*
    Returns an object, whose keys are changed properties, and value is an
    [oldProp, newProp] array.

    @method changedAttributes
    @private
  */
  changedAttributes() {
    let oldData = this._data;
    let currentData = this._attributes;
    let inFlightData = this._inFlightAttributes;
    let newData = emberAssign(copy(inFlightData), currentData);
    let diffData = Object.create(null);
    let newDataKeys = Object.keys(newData);

    for (let i = 0, length = newDataKeys.length; i < length; i++) {
      let key = newDataKeys[i];
      diffData[key] = [oldData[key], newData[key]];
    }

    return diffData;
  }

  rollbackAttributes() {
    let dirtyKeys;
    if (this.hasChangedAttributes()) {
      dirtyKeys = Object.keys(this._attributes);
      this._attributes = null;
    }

    this._inFlightAttributes = null;

    // TODO Rollback nested models
    // TODO How to do rollback of nested models inside an array as we don't track them

    return dirtyKeys;
  }

  didCommit(data) {
    let changedKeys;

    // TODO This only iterates over nested models if we have updates for them
    // TODO Must notify projections for changes caused by inflight attributes
    emberAssign(this._data, this._inFlightAttributes);
    this._inFlightAttributes = null;

    if (data && data.attributes) {
      changedKeys = this._mergeUpdates(data.attributes, commitDataAndNotify);
      this._notifyProjectionProperties(changedKeys);
    }

    this._updateChangedAttributes();

    if (!this.id && data && data.id) {
      this.id = coerceId(data.id);
      if (this.baseModelName) {
        // Fresh projection was saved, we need to connect it with the base model data
        let projectionData = this._data;
        this._initBaseModelData(this.baseModelName, this.id);
        // TODO We only do this because there might be inflight attributes, which the server
        // didn't include in the response
        this.baseModelData._inverseMergeUpdates(projectionData);
        // we need to reset the __data to reread it from the base model data
        this.__data = null;
      }
    }

    return changedKeys || [];
  }

  getHasMany() {}

  setHasMany() {}

  commitWasRejected() {
    let keys = Object.keys(this._inFlightAttributes);
    if (keys.length > 0) {
      let attrs = this._attributes;
      for (let i = 0; i < keys.length; i++) {
        if (attrs[keys[i]] === undefined) {
          attrs[keys[i]] = this._inFlightAttributes[keys[i]];
        }
      }
    }
    this._inFlightAttributes = null;

    // TODO Reject inflight for nested models as well
  }

  getBelongsTo() {}

  setBelongsTo() {}

  setAttr(key, value) {
    let originalValue;
    // Add the new value to the changed attributes hash
    this._attributes[key] = value;

    if (key in this._inFlightAttributes) {
      originalValue = this._inFlightAttributes[key];
    } else {
      originalValue = this._data[key];
    }
    // If we went back to our original value, we shouldn't keep the attribute around anymore
    if (value === originalValue) {
      delete this._attributes[key];
    }
  }

  getAttr(key) {
    if (key in this._attributes) {
      return this._attributes[key];
    } else if (key in this._inFlightAttributes) {
      return this._inFlightAttributes[key];
    } else {
      return this._data[key];
    }
  }

  hasAttr(key) {
    return key in this._attributes || key in this._inFlightAttributes || key in this._data;
  }

  unloadRecord() {
    if (this.isDestroyed) {
      return;
    }
    if (this.baseModelData || this._areAllProjectionsDestroyed()) {
      this.reset();
      this.destroy();
    }
  }

  destroy() {
    if (this.baseModelData) {
      this.baseModelData._unregisterProjection(this);
    }
    this.isDestroyed = true;
    this.storeWrapper.disconnectRecord(this.modelName, this.id, this.clientId);
  }

  removeFromInverseRelationships() {}

  clientDidCreate() {}

  getOrCreateNestedModelData(key, modelName, id, internalModel) {
    let nestedModelData = this._nestedModelDatas[key];
    if (!nestedModelData) {
      nestedModelData = this._nestedModelDatas[key] = this.createNestedModelData(
        modelName,
        id,
        internalModel
      );
    }
    return nestedModelData;
  }

  createNestedModelData(modelName, id, internalModel) {
    let storeWrapper = new NestedModelDataWrapper(internalModel);
    return new M3ModelData(modelName, id, null, storeWrapper, this.store);
  }

  destroyNestedModelData(key) {
    let nestedModelData = this._nestedModelDatas[key];
    if (nestedModelData) {
      // destroy
      delete this._nestedModelDatas[key];
    }
  }

  hasNestedModelData(key) {
    return !!this._nestedModelDatas[key];
  }

  get _attributes() {
    if (this.__attributes === null) {
      this.__attributes = Object.create(null);
    }
    return this.__attributes;
  }

  set _attributes(v) {
    this.__attributes = v;
  }

  get _data() {
    if (this.baseModelData !== null) {
      return this.baseModelData._data;
    }
    if (this.__data === null) {
      this.__data = Object.create(null);
    }
    return this.__data;
  }

  get _inFlightAttributes() {
    if (this.__inFlightAttributes === null) {
      this.__inFlightAttributes = Object.create(null);
    }
    return this.__inFlightAttributes;
  }

  set _inFlightAttributes(v) {
    this.__inFlightAttributes = v;
  }

  get _nestedModelDatas() {
    if (this.__nestedModelsData === null) {
      this.__nestedModelsData = Object.create(null);
    }
    return this.__nestedModelsData;
  }

  get _projections() {
    if (this.baseModelData !== null) {
      return this.baseModelData._projections;
    }
    return this.__projections;
  }

  _initBaseModelData(modelName, id) {
    this.baseModelData = this.store.modelDataFor(modelName, id);
    this.baseModelData._registerProjection(this);
  }

  _registerProjection(modelData) {
    if (!this.__projections) {
      // we ensure projections contains the base as well
      // so we have complete list of all related model datas
      this.__projections = [this];
    }
    this.__projections.push(modelData);
  }

  _unregisterProjection(modelData) {
    if (!this.__projections) {
      return;
    }
    let idx = this.__projections.indexOf(modelData);
    if (idx === -1) {
      return;
    }
    this.__projections.splice(idx, 1);

    // if all projetions have been destroyed and the record is not use, destroy as well
    if (
      this._areAllProjectionsDestroyed() &&
      !this.storeWrapper.isRecordInUse(this.modelName, this.id, this.clientId)
    ) {
      this.destroy();
    }
  }

  _areAllProjectionsDestroyed() {
    if (!this.__projections) {
      // no projections were ever registered
      return true;
    }
    // if this model data is the last one in the projections list, then all of the others have been destroyed
    // note: should not be possible to get into state of no projections (projections.length === 0)
    return this.__projections.length === 1 && this.__projections[0] === this;
  }

  _inverseMergeUpdates(updates) {
    // TODO Add more tests for this case
    // TODO Add support for nested objects
    if (!updates) {
      return;
    }
    let data = this._data;

    let updatedKeys = Object.keys(updates);
    for (let i = 0; i < updatedKeys.length; i++) {
      let key = updatedKeys[i];

      if (key in data) {
        continue;
      }
      data[key] = updates[key];
    }
  }

  /**
   *
   * @param updates
   * @param nestedCallback a callback for updating the data of a nested model-data instance
   * @returns {Array}
   * @private
   */
  _mergeUpdates(updates, nestedCallback) {
    let data = this._data;

    let changedKeys = [];

    if (!updates) {
      // no changes
      return changedKeys;
    }

    let updatedKeys = Object.keys(updates);

    for (let i = 0; i < updatedKeys.length; i++) {
      let key = updatedKeys[i];
      let newValue = updates[key];

      if (isEqual(data[key], newValue)) {
        // values are equal, nothing to do
        // note, updates to objects should always result in new object or there will be nothing to update
        continue;
      }

      if (this.hasNestedModelData(key)) {
        let nested = this.getOrCreateNestedModelData(key);

        // we need to compute the new nested type, hopefully it is not too slow
        let newNestedDef = this._schema.computeNestedModel(key, newValue, this.modelName);
        let newType = newNestedDef && newNestedDef.type && dasherize(newNestedDef.type);
        let isSameType =
          newType === nested.modelName || (isNone(newType) && isNone(nested.modelName));

        let newId = newNestedDef && newNestedDef.id;
        let isSameId = newId === nested.id || (isNone(newId) && isNone(nested.id));

        if (newNestedDef && isSameType && isSameId) {
          nestedCallback(nested, newValue);
          continue;
        }

        // not an embedded object anymore or type changed, destroy the nested model data
        this.destroyNestedModelData(key);
      }

      changedKeys.push(key);
      data[key] = newValue;
    }

    return changedKeys;
  }

  _notifyRecordProperties(changedKeys) {
    Ember.beginPropertyChanges();
    for (let i = 0; i < changedKeys.length; i++) {
      this.storeWrapper.notifyPropertyChange(
        this.modelName,
        this.id,
        this.clientId,
        changedKeys[i]
      );
    }
    Ember.endPropertyChanges();
  }

  _notifyProjectionProperties(changedKeys) {
    let projections = this._projections;
    if (projections) {
      for (let i = 0; i < projections.length; i++) {
        if (projections[i] !== this) {
          projections[i]._notifyRecordProperties(changedKeys);
        }
      }
    }
  }

  /*
    Checks if the attributes which are considered as changed are still
    different to the state which is acknowledged by the server.

    This method is needed when data for the internal model is pushed and the
    pushed data might acknowledge dirty attributes as confirmed.

    @method updateChangedAttributes
    @private
   */
  _updateChangedAttributes() {
    let changedAttributes = this.changedAttributes();
    let changedAttributeNames = Object.keys(changedAttributes);
    let attrs = this._attributes;

    for (let i = 0, length = changedAttributeNames.length; i < length; i++) {
      let attribute = changedAttributeNames[i];
      let data = changedAttributes[attribute];
      let oldData = data[0];
      let newData = data[1];

      if (oldData === newData) {
        delete attrs[attribute];
      }
    }
  }

  toString() {
    return `<${this.modelName}:${this.id}>`;
  }
}
