'use strict';

var _        = require('lodash');
var assert   = require('assert');
var Query    = require('./query');
var Snapshot = require('./snapshot');
var Queue    = require('./queue');
var utils    = require('./utils');
var Auth     = require('./auth');

function MockFirebase(currentPath, data, parent, name) {
  // represents the fake url
  //todo should unwrap nested paths; Firebase
  //todo accepts sub-paths, mock should too
  this.currentPath = currentPath || 'Mock://';

  // see failNext()
  this.errs = {};

  // used for setPriorty and moving records
  this.priority = null;

  // null for the root path
  this.myName = parent? name : extractName(currentPath);

  // see autoFlush() and flush()
  this.flushDelay = parent? parent.flushDelay : false;
  this.flushQueue = parent? parent.flushQueue : new Queue();

  // stores the listeners for various event types
  this._events = { value: [], child_added: [], child_removed: [], child_changed: [], child_moved: [] };

  // allows changes to be propagated between child/parent instances
  this.parentRef = parent||null;
  this.children = {};
  if (parent) parent.children[this.key()] = this;

  // stores sorted keys in data for priority ordering
  this.sortedDataKeys = [];

  // do not modify this directly, use set() and flush(true)
  this.data = null;
  this._dataChanged(_.cloneDeep(data) || null);

  // stores the last auto id generated by push() for tests
  this._lastAutoId = null;

  _.extend(this, new Auth());
}

MockFirebase.prototype = {
  flush: function(delay) {
    this.flushQueue.flush(delay);
    return this;
  },

  autoFlush: function(delay){
    if(_.isUndefined(delay)) { delay = true; }
    if( this.flushDelay !== delay ) {
      this.flushDelay = delay;
      _.each(this.children, function(c) {
        c.autoFlush(delay);
      });
      if( this.parentRef ) { this.parentRef.autoFlush(delay); }
    }
    return this;
  },

  splitFlushQueue: function() {
    this.flushQueue = new Queue();
  },

  joinFlushQueue: function() {
    if( this.parent ) {
      this.flushQueue = this.parent.flushQueue;
    }
  },

  failNext: function(methodName, error) {
    this.errs[methodName] = error;
  },

  forceCancel: function(error, event, callback, context) {
    var self = this, events = self._events;
    _.each(event? [event] : _.keys(events), function(eventType) {
      var list = _.filter(events[eventType], function(parts) {
        return !event || !callback || (callback === parts[0] && context === parts[1]);
      });
      _.each(list, function(parts) {
        parts[2].call(parts[1], error);
        self.off(event, callback, context);
      });
    });
  },

  getData: function() {
    return _.cloneDeep(this.data);
  },

  getKeys: function() {
    return this.sortedDataKeys.slice();
  },

  fakeEvent: function(event, key, data, prevChild, pri) {
    if( arguments.length < 5 ) { pri = null; }
    if( arguments.length < 4 ) { prevChild = null; }
    if( arguments.length < 3 ) { data = null; }
    var self = this;
    var ref = event==='value'? self : self.child(key);
    var snap = new Snapshot(ref, data, pri);
    self._defer(function() {
      _.each(self._events[event], function (parts) {
        var fn = parts[0], context = parts[1];
        if (_.contains(['child_added', 'child_moved'], event)) {
          fn.call(context, snap, prevChild);
        }
        else {
          fn.call(context, snap);
        }
      });
    });
    return this;
  },

  toString: function() {
    return this.currentPath;
  },

  child: function(childPath) {
    assert(childPath, 'A child path is required');
    var parts = _.compact(childPath.split('/'));
    var childKey = parts.shift();
    var child = this.children[childKey];
    if (!child) {
      child = new MockFirebase(utils.mergePaths(this.currentPath, childKey), this._childData(childKey), this, childKey);
      this.children[child.key()] = child;
    }
    if (parts.length) {
      child = child.child(parts.join('/'));
    }
    return child;
  },

  set: function(data, callback) {
    var self = this;
    var err = this._nextErr('set');
    data = _.cloneDeep(data);
    this._defer(function() {
      if( err === null ) {
        self._dataChanged(data);
      }
      if (callback) callback(err);
    });
  },

  update: function(changes, callback) {
    assert.equal(typeof changes, 'object', 'First argument must be an object when calling $update');
    var self = this;
    var err = this._nextErr('update');
    var base = this.getData();
    var data = _.assign(_.isObject(base) ? base : {}, changes);
    this._defer(function() {
      if (!err) {
        self._dataChanged(data);
      }
      if (callback) callback(err);
    });
  },

  setPriority: function(newPriority, callback) {
    var self = this;
    var err = this._nextErr('setPriority');
    self._defer(function() {
      self._priChanged(newPriority);
      if (callback) callback(err);
    });
  },

  setWithPriority: function(data, pri, callback) {
    this.setPriority(pri);
    this.set(data, callback);
  },

  key: function() {
    return this.myName;
  },

  name: function() {
    console.warn('ref.name() is deprecated. Use ref.key()');
    return this.key.apply(this, arguments);
  },

  ref: function() {
    return this;
  },

  parent: function() {
    return this.parentRef;
  },

  root: function() {
    var next = this;
    while (next.parentRef) {
      next = next.parentRef;
    }
    return next;
  },

  push: function(data, callback) {
    var child = this.child(this._newAutoId());
    var err = this._nextErr('push');
    if (err) child.failNext('set', err);
    if (arguments.length && data !== null) {
      // currently, callback only invoked if child exists
      child.set(data, callback);
    }
    return child;
  },

  once: function(event, callback, cancel, context) {
    var self = this;
    if( arguments.length === 3 && !_.isFunction(cancel) ) {
      context = cancel;
      cancel = function() {};
    }
    else if( arguments.length < 3 ) {
      cancel = function() {};
      context = null;
    }
    var err = this._nextErr('once');
    if( err ) {
      this._defer(function() {
        cancel.call(context, err);
      });
    }
    else {
      var fn = function (snap) {
        self.off(event, fn, context);
        callback.call(context, snap);
      };

      this.on(event, fn, cancel, context);
    }
  },

  remove: function(callback) {
    var self = this;
    var err = this._nextErr('remove');
    this._defer(function() {
      if( err === null ) {
        self._dataChanged(null);
      }
      if (callback) callback(err);
    });
    return this;
  },

  on: function(event, callback, cancel, context) {
    if (arguments.length === 3 && typeof cancel !== 'function') {
      context = cancel;
      cancel = noop;
    }
    else if (arguments.length < 3) {
      cancel = noop;
    }

    var err = this._nextErr('on');
    if (err) {
      this._defer(function() {
        cancel.call(context, err);
      });
    }
    else {
      var handlers = [callback, context, cancel];
      this._events[event].push(handlers);
      var self = this;
      if (event === 'value') {
        self._defer(function() {
          // make sure off() wasn't called in the interim
          if (self._events[event].indexOf(handlers) > -1) {
            callback.call(context, new Snapshot(self, self.getData(), self.priority));
          }
        });
      }
      else if (event === 'child_added') {
        self._defer(function() {
          if (self._events[event].indexOf(handlers) > -1) {
            var prev = null;
            _.each(self.sortedDataKeys, function (k) {
              var child = self.child(k);
              callback.call(context, new Snapshot(child, child.getData(), child.priority), prev);
              prev = k;
            });
          }
        });
      }
    }
  },

  off: function(event, callback, context) {
    if( !event ) {
      for (var key in this._events)
        if( this._events.hasOwnProperty(key) )
          this.off(key);
    }
    else if( callback ) {
      var list = this._events[event];
      var newList = this._events[event] = [];
      _.each(list, function(parts) {
        if( parts[0] !== callback || parts[1] !== context ) {
          newList.push(parts);
        }
      });
    }
    else {
      this._events[event] = [];
    }
  },

  transaction: function(valueFn, finishedFn, applyLocally) {
    var self = this;
    this._defer(function() {
      var err = self._nextErr('transaction');
      // unlike most defer methods, self will use the value as it exists at the time
      // the transaction is actually invoked, which is the eventual consistent value
      // it would have in reality
      var res = valueFn(self.getData());
      var newData = _.isUndefined(res) || err? self.getData() : res;
      self._dataChanged(newData);
      if (typeof finishedFn === 'function') {
        finishedFn(err, err === null && !_.isUndefined(res), new Snapshot(self, newData, self.priority));
      }
    });
    return [valueFn, finishedFn, applyLocally];
  },

  /**
   * Just a stub at this point.
   * @param {int} limit
   */
  limit: function(limit) {
    return new Query(this).limit(limit);
  },

  startAt: function(priority, key) {
    return new Query(this).startAt(priority, key);
  },

  endAt: function(priority, key) {
    return new Query(this).endAt(priority, key);
  },

  _childChanged: function(ref) {
    var events = [];
    var childKey = ref.key();
    var data = ref.getData();
    if( data === null ) {
      this._removeChild(childKey, events);
    }
    else {
      this._updateOrAdd(childKey, data, events);
    }
    this._triggerAll(events);
  },

  _dataChanged: function(unparsedData) {
    var self = this;
    var pri = utils.getMeta(unparsedData, 'priority', self.priority);
    var data = utils.cleanData(unparsedData);
    if( pri !== self.priority ) {
      self._priChanged(pri);
    }
    if( !_.isEqual(data, self.data) ) {
      var oldKeys = _.keys(self.data).sort();
      var newKeys = _.keys(data).sort();
      var keysToRemove = _.difference(oldKeys, newKeys);
      var keysToChange = _.difference(newKeys, keysToRemove);
      var events = [];

      _.each(keysToRemove, function(key) {
        self._removeChild(key, events);
      });

      if(!_.isObject(data)) {
        events.push(false);
        self.data = data;
      }
      else {
        _.each(keysToChange, function(key) {
          self._updateOrAdd(key, unparsedData[key], events);
        });
      }

      // update order of my child keys
      self._resort();

      // trigger parent notifications after all children have
      // been processed
      self._triggerAll(events);
    }
  },

  _priChanged: function(newPriority) {
    this.priority = newPriority;
    if( this.parentRef ) {
      this.parentRef._resort(this.key());
    }
  },

  _getPri: function(key) {
    return _.has(this.children, key)? this.children[key].priority : null;
  },

  _resort: function(childKeyMoved) {
    var self = this;
    self.sortedDataKeys.sort(_.bind(self.childComparator, self));
    // resort the data object to match our keys so value events return ordered content
    var oldDat = _.assign({}, self.data);
    _.each(oldDat, function(v,k) { delete self.data[k]; });
    _.each(self.sortedDataKeys, function(k) {
      self.data[k] = oldDat[k];
    });
    if( !_.isUndefined(childKeyMoved) && _.has(self.data, childKeyMoved) ) {
      self._trigger('child_moved', self.data[childKeyMoved], self._getPri(childKeyMoved), childKeyMoved);
    }
  },

  _addKey: function(newKey) {
    if(_.indexOf(this.sortedDataKeys, newKey) === -1) {
      this.sortedDataKeys.push(newKey);
      this._resort();
    }
  },

  _dropKey: function(key) {
    var i = _.indexOf(this.sortedDataKeys, key);
    if( i > -1 ) {
      this.sortedDataKeys.splice(i, 1);
    }
  },

  _defer: function() {
    //todo should probably be taking some sort of snapshot of my data here and passing
    //todo that into `fn` for reference
    this.flushQueue.push(Array.prototype.slice.call(arguments, 0));
    if( this.flushDelay !== false ) { this.flush(this.flushDelay); }
  },

  _trigger: function(event, data, pri, key) {
    var self = this, ref = event==='value'? self : self.child(key);
    var snap = new Snapshot(ref, data, pri);
    _.each(self._events[event], function(parts) {
      var fn = parts[0], context = parts[1];
      if(_.contains(['child_added', 'child_moved'], event)) {
        fn.call(context, snap, self._getPrevChild(key));
      }
      else {
        fn.call(context, snap);
      }
    });
  },

  _triggerAll: function(events) {
    var self = this;
    if( !events.length ) { return; }
    _.each(events, function(event) {
      if (event !== false) self._trigger.apply(self, event);
    });
    self._trigger('value', self.data, self.priority);
    if( self.parentRef ) {
      self.parentRef._childChanged(self);
    }
  },

  _updateOrAdd: function(key, data, events) {
    var exists = _.isObject(this.data) && this.data.hasOwnProperty(key);
    if( !exists ) {
      return this._addChild(key, data, events);
    }
    else {
      return this._updateChild(key, data, events);
    }
  },

  _addChild: function(key, data, events) {
    if(this._hasChild(key)) {
      throw new Error('Tried to add existing object', key);
    }
    if( !_.isObject(this.data) ) {
      this.data = {};
    }
    this._addKey(key);
    this.data[key] = utils.cleanData(data);
    var c = this.child(key);
    c._dataChanged(data);
    if (events) events.push(['child_added', c.getData(), c.priority, key]);
  },

  _removeChild: function(key, events) {
    if(this._hasChild(key)) {
      this._dropKey(key);
      var data = this.data[key];
      delete this.data[key];
      if(_.isEmpty(this.data)) {
        this.data = null;
      }
      if(_.has(this.children, key)) {
        this.children[key]._dataChanged(null);
      }
      if (events) events.push(['child_removed', data, null, key]);
    }
  },

  _updateChild: function(key, data, events) {
    var cdata = utils.cleanData(data);
    if(_.isObject(this.data) && _.has(this.data,key) && !_.isEqual(this.data[key], cdata)) {
      this.data[key] = cdata;
      var c = this.child(key);
      c._dataChanged(data);
      if (events) events.push(['child_changed', c.getData(), c.priority, key]);
    }
  },

  _newAutoId: function() {
    this._lastAutoId = 'mock-'+Date.now()+'-'+Math.floor(Math.random()*10000);
    return this._lastAutoId;
  },

  _nextErr: function(type) {
    var err = this.errs[type];
    delete this.errs[type];
    return err||null;
  },

  _hasChild: function(key) {
    return _.isObject(this.data) && _.has(this.data, key);
  },

  _childData: function(key) {
    return this._hasChild(key)? this.data[key] : null;
  },

  _getPrevChild: function(key) {
//      this._resort();
    var keys = this.sortedDataKeys;
    var i = _.indexOf(keys, key);
    if( i === -1 ) {
      keys = keys.slice();
      keys.push(key);
      keys.sort(_.bind(this.childComparator, this));
      i = _.indexOf(keys, key);
    }
    return i === 0? null : keys[i-1];
  },

  childComparator: function(a, b) {
    var aPri = this._getPri(a);
    var bPri = this._getPri(b);
    var x = utils.priorityComparator(aPri, bPri);
    if( x === 0 ) {
      if( a !== b ) {
        x = a < b? -1 : 1;
      }
    }
    return x;
  }
};

function extractName(path) {
  return ((path || '').match(/\/([^.$\[\]#\/]+)$/)||[null, null])[1];
}

function noop () {}

module.exports = MockFirebase;
