var _ = require('underscore-contrib')
var async = require('async')
var debug = require('debug')('api:model')
var moment = require('moment')
var path = require('path')

var Composer = require(path.join(__dirname, '/composer')).Composer
var config = require(path.join(__dirname, '/../../../config'))
var Connection = require(path.join(__dirname, '/connection'))
var formatError = require('@dadi/format-error')
var History = require(path.join(__dirname, '/history'))
var Hook = require(path.join(__dirname, '/hook'))
var logger = require('@dadi/logger')
var queryUtils = require(path.join(__dirname, '/utils'))
var Validator = require(path.join(__dirname, '/validator'))

// track all models that have been instantiated by this process
var _models = {}

/**
 * Creates a new Model instance
 * @constructor
 * @classdesc
 */
var Model = function (name, schema, conn, settings) {
  // attach collection name
  this.name = name

  // attach original schema
  if (_models[name] && _.isEmpty(schema)) {
    this.schema = _models[name].schema
  } else {
    this.schema = schema
  }

  // attach default settings
  this.settings = _.extend({}, settings, this.schema.settings)

  // attach display name if supplied
  if (this.settings.hasOwnProperty('displayName')) {
    this.displayName = this.settings.displayName
  }

  // composable reference fields?
  if (this.settings.hasOwnProperty('compose')) {
    this.compose = this.settings.compose
  }

  // add any configured indexes
  if (this.settings.hasOwnProperty('index')) {
    if (!Array.isArray(this.settings.index)) {
      var indexArray = []

      indexArray.push({
        keys: this.settings.index.keys,
        options: this.settings.index.options || {}
      })

      this.settings.index = indexArray
    }
  }

  // create connection for this model
  if (conn) {
    this.connection = conn
  } else {
    this.connection = Connection({ database: settings.database, collection: this.name }, this.name, config.get('datastore'))
  }

  this.connection.setMaxListeners(35)

  if (config.get('env') !== 'test') {
    this.connection.once('error', (err) => {
      logger.error(err)
    })
  }

  _models[name] = this

  // setup validation context
  this.validate = new Validator(this)

  this.composer = new Composer(this)

  // setup history context unless requested not to
  this.storeRevisions = (this.settings.storeRevisions !== false)

  if (this.storeRevisions) {
    this.history = new History(this)
    // attach revision collection for this model.
    // if no value is specified, use 'History' suffix by default
    this.revisionCollection = (this.settings.revisionCollection ? this.settings.revisionCollection : this.name + 'History')
  }

  if (this.settings.index) {
    this.createIndex(() => {})
  }
}

/**
 *
 */
Model.prototype.createIndex = function (done) {
  var _done = (database) => {
    database.index(this.name, this.settings.index).then(result => {
      done(result)
    })
  }

  if (!this.connection.db) {
    // wait 1 second before continuing, this will
    // stop the need to set a listener on every model
    // as the db should have become available
    setTimeout(() => {
      if (!this.connection.db) {
        this.connection.once('connect', _done)
      } else {
        return _done(this.connection.db)
      }
    }, 1000)
  } else {
    return _done(this.connection.db)
  }
}

/**
 *
 */
Model.prototype.getIndexes = function (done) {
  var _done = database => {
    database.getIndexes(this.name).then(result => {
      done(result)
    })
  }

  if (!this.connection.db) {
    this.connection.once('connect', _done)
  } else {
    return _done(this.connection.db)
  }
}

/**
 * Create a document in the database
 *
 * @param {object} documents - a document, or Array of documents to insert in the database
 * @param {object} internals
 * @param {function} done
 * @return undefined
 * @api public
 */
Model.prototype.create = function (documents, internals, done, req) {
  debug('create %o %o', documents, internals)

  if (!Array.isArray(documents)) {
    documents = [documents]
  }

  // internals will not be validated, i.e. should not be user input
  if (typeof internals === 'function') {
    done = internals
  }

  // validate each doc
  var validation

  documents.forEach(doc => {
    if (validation === undefined || validation.success) {
      validation = this.validate.schema(doc)
    }
  })

  if (!validation.success) {
    var err = validationError('Validation Failed')
    err.success = validation.success
    err.errors = validation.errors
    return done(err)
  }

  if (typeof internals === 'object' && internals != null) { // not null and not undefined
    documents.forEach(doc => {
      doc = _.extend(doc, internals)
    })
  }

  //
  if (this.history) {
    documents.forEach(doc => {
      doc.history = []
    })
  }

  // add initial document revision number
  documents.forEach(doc => {
    doc.v = 1
  })

  // ObjectIDs
  // documents.forEach(function (doc) {
  //   doc = self.convertObjectIdsForSave(self.schema, doc)
  // })

  // DateTime
  documents.forEach(doc => {
    doc = this.convertDateTimeForSave(this.schema, doc)
  })

  var startInsert = (database) => {
    // Running `beforeCreate` hooks
    if (this.settings.hooks && this.settings.hooks.beforeCreate) {
      var processedDocs = 0

      documents.forEach((doc, docIndex) => {
        async.reduce(this.settings.hooks.beforeCreate, doc, (current, hookConfig, callback) => {
          var hook = new Hook(hookConfig, 'beforeCreate')

          Promise.resolve(hook.apply(current, this.schema, this.name, req)).then((newDoc) => {
            callback((newDoc === null) ? {} : null, newDoc)
          }).catch(err => {
            callback(hook.formatError(err))
          })
        }, (err, result) => {
          processedDocs++

          if (processedDocs === documents.length) {
            if (err) {
              var errorResponse = {
                success: false,
                errors: err
              }

              return done(errorResponse)
            } else {
              return saveDocuments(database)
            }
          }
        })
      })
    } else {
      return saveDocuments(database)
    }
  }

  var saveDocuments = (database) => {
    database.insert(documents, this.name, this.schema).then(results => {
      var returnData = {
        results: results
      }

      this.composer.compose(returnData.results, (obj) => {
        returnData.results = obj

        // apply any existing `afterCreate` hooks
        if (this.settings.hasOwnProperty('hooks') && (typeof this.settings.hooks.afterCreate === 'object')) {
          returnData.results.forEach((doc) => {
            this.settings.hooks.afterCreate.forEach((hookConfig, index) => {
              var hook = new Hook(this.settings.hooks.afterCreate[index], 'afterCreate')

              return hook.apply(doc, this.schema, this.name)
            })
          })
        }

        return done(null, returnData)
      })
    }).catch((err) => {
      return done(err)
    })
  }

  // Pre-composed References
  this.composer.setApiVersion(internals.apiVersion)

  // before the primary document insert, process any Reference fields
  // that have been passed as subdocuments rather than id strings
  _.each(documents, (doc, idx) => {
    this.composer.createFromComposed(doc, req, (err, result) => {
      if (err) {
        return done(err.json)
      }

      doc = result

      if (idx === documents.length - 1) {
        if (this.connection.db) {
          return startInsert(this.connection.db)
        } else {
          // if the db is not connected queue the insert
          this.connection.once('connect', startInsert)
        }
      }
    })
  })
}

/**
 * Attaches the full history of each document
 * before returning the results
 */
Model.prototype.injectHistory = function (data, options) {
  return new Promise((resolve, reject) => {
    if (data.results.length === 0) {
      return resolve(data)
    }

    _.each(data.results, (doc, idx) => {
      this.revisions(doc._id, options, (err, history) => {
        if (err) console.log(err)
        doc.history = history

        if (idx === data.results.length - 1) {
          return resolve(data)
        }
      })
    })
  })
}

Model.prototype.convertDateTimeForSave = function (schema, obj) {
  Object.keys(schema).filter(function (key) {
    return schema[key].type === 'DateTime' && obj[key] !== null && !_.isUndefined(obj[key])
  }).forEach(function (key) {
    switch (schema[key].format) {
      case 'unix':
        obj[key] = moment(obj[key]).valueOf()
        break
      case 'iso':
        obj[key] = new Date(moment(obj[key]).toISOString())
        break
      default:
        if (schema[key].format) {
          obj[key] = moment(obj[key], schema[key].format || ['MM-DD-YYYY', 'YYYY-MM-DD', 'DD MMMM YYYY', 'DD/MM/YYYY']).format()
        } else {
          obj[key] = new Date(moment(obj[key])).toISOString()
        }
    }
  })

  return obj
}

/**
 * Lookup documents in the database, then give back a count
 *
 * @param {Object} query
 * @param {Function} done
 * @return undefined
 * @api public
 */
Model.prototype.count = function (query, options, done) {
  if (typeof options === 'function') {
    done = options
    options = {}
  }

  // query = queryUtils.makeCaseInsensitive(query, this.schema)
  // query = queryUtils.convertApparentObjectIds(query, this.schema)

  var validation = this.validate.query(query)

  if (!validation.success) {
    var err = validationError('Bad Query')
    err.json = validation
    return done(err)
  }

  if (_.isObject(query)) {
    this.find(query, options, (err, results) => {
      if (err) return done(err)
      return done(null, { metadata: results.metadata })
    })
  } else {
    return done(validationError('Bad Query'))
  }
}

/**
 * Lookup documents in the database
 *
 * @param {Object} query
 * @param {Function} done
 * @return undefined
 * @api public
 */
Model.prototype.find = function (query, options, done) {
  if (typeof options === 'function') {
    done = options
    options = {}
  }

  var self = this

  // Set up a queue of functions to run before finally sending
  // data back to the client
  var doneQueue = []

  var runDoneQueue = function (err, data) {
    if (doneQueue.length > 0) {
      // Assign err, data to the first function
      doneQueue.splice(0, 0, async.apply(assignVariables, err, data))

      async.waterfall(doneQueue, function (arg1, err, data) {
        return done(err, data)
      })
    } else {
      // Nothing queued, send data back
      return done(err, data)
    }
  }

  // Assign (err, data) variables to the first function in the queue
  function assignVariables (err, data, callback) {
    callback(null, err, data)
  }

  // Queue the history resolving function
  if (options.includeHistory) {
    doneQueue.push((err, data, callback) => {
      if (err) {
        return callback(null, err, data)
      } else {
        this.injectHistory(data, options).then((data) => {
          return callback(null, err, data)
        })
      }
    })

    delete options.includeHistory
  }

  query = queryUtils.makeCaseInsensitive(query, self.schema)
  // query = queryUtils.convertApparentObjectIds(query, self.schema)

  debug('find %o %o', query, options)

  if (JSON.stringify(query).indexOf('object Object') > 0) {
    console.trace()
  }

  // override the model's settings with a value from the options object
  if (options.hasOwnProperty('compose')) {
    self.compose = options.compose
    delete options.compose
  }

  var validation = this.validate.query(query)
  if (!validation.success) {
    var err = validationError('Bad Query')
    err.json = validation
    return done(err)
  }

  var _done

  if (_.isArray(query)) {
    // have we been passed an aggregation pipeline query?
    _done = function (database) {
      // database.collection(self.name).aggregate(query, options, function (err, result) {
      //   if (err) return done(err)
      //   done(null, result)
      // })
      done('Not implemented')
    }
  } else if (_.isObject(query)) {
    _done = (database) => {
      if (queryUtils.containsNestedReferenceFields(query, this.schema)) {
        var queries = queryUtils.processReferenceFieldQuery(query, this.schema)

        debug('find reference %o', queries)

        // processReferenceFieldQuery sends back an array of queries
        // [0] is the query with reference field parts removed
        // [1] contains the reference field parts
        query = queries[0]

        var referenceFieldQuery = queries[1]
        var referenceFieldKeys = Object.keys(referenceFieldQuery)
        var queue = []

        // for each reference field key, query the specified collection
        // to obtain an _id value
        _.each(referenceFieldKeys, (key, index) => {
          queue.push((cb) => {
            var keyParts = key.split('.')

            var collection = ''
            var collectionKey = keyParts[0]
            var linkKey
            var queryKey
            var queryValue = referenceFieldQuery[key]
            var collectionSettings = queryUtils.getSchemaOrParent(collectionKey, this.schema).settings || {}
            var collectionLevelCompose = true

            if (collectionKey !== collectionSettings.collection) {
              collection = collectionSettings.collection
            } else {
              collection = collectionKey
            }

            var fieldsObj = {}
            if (collectionSettings.fields) {
              collectionSettings.fields.forEach(function (field) {
                fieldsObj[field] = 1
              })
            }

            queryKey = keyParts[1]
            var collectionQuery = {}

            if (keyParts.length === 2) {
              collectionQuery[queryKey] = queryValue
            } else {
              linkKey = keyParts[1]
              queryKey = keyParts[2]
            }

            // if we already have a value for this field inserted
            // into the final query object (e.g. a parent nested query has been done first),
            // supplement the current query with the ids
            if (query[collectionKey]) {
              collectionQuery['_id'] = query[collectionKey]
              // collectionQuery = queryUtils.convertApparentObjectIds(collectionQuery, self.schema)
            }

            // query the reference collection
            debug('find reference in %s with %o', collection, collectionQuery)

            var referenceModel = new Model(collection, {}, null, { database: collectionSettings.database || self.settings.database, compose: collectionLevelCompose })

            referenceModel.find(collectionQuery, { fields: fieldsObj }, (err, results) => {
              if (err) return done(err)

              var ids

              if (results && results.results && results.results.length) {
                results = results.results

                if (!linkKey) { // i.e. it's a one-level nested query
                  ids = _.map(_.pluck(results, '_id'), (id) => { return id.toString() })

                  // update the original query with a query for the obtained _id
                  // using the appropriate query type for whether the reference settings
                  // allows storing as arrays or not
                  query[collectionKey] = collectionSettings.multiple ? { '$containsAny': ids } : ids[0]
                  // query[collectionKey] = collectionSettings.multiple ? { '$in': ids } : ids[0]
                } else {
                  // filter the results using linkKey
                  // 1. get the _id of the result matching { queryKey: queryValue }
                  var parent = _.filter(results, result => {
                    return new RegExp(queryValue).test(result[queryKey]) === true
                  })

                  if (parent[0]) {
                    var children = _.filter(results, result => {
                      if (result[linkKey]) {
                        if (typeof result[linkKey] === 'string' && result[linkKey].toString() === parent[0]._id.toString()) {
                          return result
                        } else if (typeof result[linkKey] === 'object') {
                          if (result[linkKey].toString() === '[object Object]' && result[linkKey]._id.toString() === parent[0]._id.toString()) {
                            return result
                          } else if (result[linkKey].toString() === parent[0]._id.toString()) {
                            return result
                          }
                        }
                      }
                    })

                    ids = _.map(_.pluck(children, '_id'), id => {
                      return id.toString()
                    })
                  }

                  query[collectionKey] = { '$in': ids || [] }
                }
              } else {
                // Nothing found in the reference collection, add empty criteria to the main query
                query[collectionKey] = collectionSettings.multiple
                  ? { '$in': [] }
                  : ''
              }

              cb(null, query)
            })
          })
        })
        // })

        async.series(queue,
          function (err, results) {
            if (err) console.log(err)
            runFind()
          }
        )
      } else {
        runFind()
      }

      // perform the actual find operation
      function runFind () {
        var queryOptions = _.clone(options)
        delete queryOptions.historyFilters

        database.find(query, self.name, queryOptions, self.schema).then((results) => {
          // NOTE: datastore returns object containing results + metadata
          //  {
          //    results: [ { _id: 590bbc9d29ccaf1cb8ab0ed1, fieldName: 'foo' } ],
          //    metadata: { page: 1, offset: 0, totalCount: 1, totalPages: 1 }
          //  }

          if (self.compose) {
            self.composer.setApiVersion(query.apiVersion)

            self.composer.compose(results.results, (obj) => {
              results.results = obj
              runDoneQueue(null, results)
            })
          } else {
            runDoneQueue(null, results)
          }
        })
      }
    }
  } else {
    var error = validationError('Bad Query')
    // err.json = {success: false, errors: [{message: 'Query must be either a JSON array or a JSON object.'}]}
    // console.log(err)
    return done(error)
  }

  if (this.connection.db) return _done(this.connection.db)

  // if the db is not connected queue the find
  this.connection.once('connect', function (database) {
    _done(database)
  })
}

/**
 * Lookup documents in the database and run any associated hooks
 *
 * @param {Object} query
 * @param {Function} done
 * @return undefined
 * @api public
 */
Model.prototype.get = function (query, options, done, req) {
  if (typeof options === 'function') {
    done = options
    options = {}
  }

  this.find(query, options, (err, results) => {
    if (this.settings.hooks && this.settings.hooks.afterGet) {
      async.reduce(this.settings.hooks.afterGet, results, (current, hookConfig, callback) => {
        var hook = new Hook(hookConfig, 'afterGet')

        Promise.resolve(hook.apply(current, this.schema, this.name, req)).then((newResults) => {
          callback((newResults === null) ? {} : null, newResults)
        }).catch(err => {
          callback(hook.formatError(err))
        })
      }, (err, finalResult) => {
        done(err, finalResult)
      })
    } else {
      done(err, results)
    }
  })
}

Model.prototype.revisions = function (id, options, done) {
  var fields = options.fields || {}
  var historyQuery = {}

  if (options.historyFilters) {
    try {
      historyQuery = JSON.parse(options.historyFilters)
    } catch (e) {}
  }

  var _done = (database) => {
    database.find({ '_id': id }, this.name, { history: 1, limit: 1 }, this.schema).then((results) => {
      debug('find in history %o', results.results)

      if (results && results.results && results.results.length && this.history) {
        historyQuery._id = {
          '$in': _.map(results.results[0].history, (id) => {
            return id.toString()
          })
        }

        database.find(historyQuery, this.revisionCollection, fields, this.schema).then((results) => {
          return done(null, results.results)
        }).catch((err) => {
          return done(err)
        })
      } else {
        return done(null, [])
      }
    }).catch((err) => {
      return done(err)
    })
  }

  if (this.connection.db) return _done(this.connection.db)

  // if the db is not connected queue the find
  this.connection.once('connect', function (database) {
    _done(database)
  })
}

/**
 * Get collection statistics
 *
 * @param {Object} options
 * @return An object representing the database collection stats
 * @api public
 */
Model.prototype.stats = function (options, done) {
  options = options || {}

  var _done = (database) => {
    database.stats(this.name, options).then((results) => {
      done(null, results)
    }).catch((err) => {
      // 'Not implemented'
      done(err)
    })
  }

  if (this.connection.db) return _done(this.connection.db)

  this.connection.once('connect', (database) => {
    _done(database)
  })
}

/**
 * Update a document in the database
 *
 * @param {Object} query
 * @param {Object} update
 * @param {Function} done
 * @return undefined
 * @api public
 */
Model.prototype.update = function (query, update, internals, done, req) {
  debug('update %s %o %o %o', req ? req.url : '', query, update, internals)

  // internals will not be validated, i.e. should not be user input
  if (typeof internals === 'function') {
    done = internals
  }

  var validation
  var err

  validation = this.validate.query(query)
  if (!validation.success) {
    err = validationError('Bad Query')
    err.json = validation
    return done(err)
  }

  validation = this.validate.schema(update, true)
  if (!validation.success) {
    err = validationError()
    err.json = validation
    return done(err)
  }

  // ObjectIDs
  // TODO: move this to MongoStore
  // update = this.convertObjectIdsForSave(this.schema, update)
  // DateTimes
  update = this.convertDateTimeForSave(this.schema, update)

  if (typeof internals === 'object' && internals != null) { // not null and not undefined
    _.extend(update, internals)
  }

  this.composer.setApiVersion(internals.apiVersion)

  var setUpdate = { $set: update, $inc: { v: 1 } }

  var startUpdate = (database) => {
    this.find(query, {}, (err, result) => {
      if (err) return done(err)

      // create a copy of the documents that matched the find
      // query, as these will be updated and we need to send back to the
      // client a full result set of modified documents
      var updatedDocs = queryUtils.snapshot(result.results)

      var saveDocuments = () => {
        database.update(query, this.name, setUpdate, { multi: true }, this.schema).then((result) => {
          // TODO: review, I don't know if sending a 404 is the right response
          // when no documents were modified
          if (result.matchedCount === 0) {
            err = new Error('Not Found')
            err.statusCode = 404
            return done(err)
          }

          var triggerAfterUpdateHook = (docs) => {
            if (this.settings.hasOwnProperty('hooks') && (typeof this.settings.hooks.afterUpdate === 'object')) {
              this.settings.hooks.afterUpdate.forEach((hookConfig, index) => {
                var hook = new Hook(this.settings.hooks.afterUpdate[index], 'afterUpdate')

                return hook.apply(docs, this.schema, this.name)
              })
            }
          }

          // var results = {}
          var promise

          // for each of the updated documents, create a history revision for it
          if (this.history) {
            promise = this.history.createEach(updatedDocs, 'update', this)
          } else {
            promise = Promise.resolve()
          }

          promise.then(() => {
            var query = {
              _id: {
                '$in': _.map(updatedDocs, (doc) => { return doc._id.toString() })
              }
            }

            return this.find(query, { compose: true }, (err, results) => {
              if (err) return done(err)

              // apply any existing `afterUpdate` hooks
              triggerAfterUpdateHook(results.results)

              return done(null, results)
            })
          }).catch((err) => {
            console.log(err)
          })
        }).catch((err) => {
          return done(err)
        })
      }

      // apply any existing `beforeUpdate` hooks, otherwise save the documents straight away
      if (this.settings.hooks && this.settings.hooks.beforeUpdate) {
        async.reduce(this.settings.hooks.beforeUpdate, update, (current, hookConfig, callback) => {
          var hook = new Hook(hookConfig, 'beforeUpdate')

          Promise.resolve(hook.apply(current, updatedDocs, this.schema, this.name, req)).then((newUpdate) => {
            callback((newUpdate === null) ? {} : null, newUpdate)
          }).catch(err => {
            callback(hook.formatError(err))
          })
        }, (err, result) => {
          if (err) {
            done(err)
          } else {
            update = result
            saveDocuments()
          }
        })
      } else {
        saveDocuments()
      }
    })
  }

  if (this.connection.db) return startUpdate(this.connection.db)

  // if the db is not connected queue the update
  this.connection.once('connect', startUpdate)
}

/**
 * Delete a document from the database
 *
 * @param {Object} query
 * @param {Function} done
 * @return undefined
 * @api public
 */
Model.prototype.delete = function (query, done, req) {
  var validation = this.validate.query(query)

  if (!validation.success) {
    var err = validationError('Bad Query')
    err.json = validation
    return done(err)
  }

  // query = queryUtils.convertApparentObjectIds(query, this.schema)

  var startDelete = (database) => {
    // apply any existing `beforeDelete` hooks, otherwise delete the documents straight away
    if (this.settings.hooks && this.settings.hooks.beforeDelete) {
      async.reduce(this.settings.hooks.beforeDelete, query, (current, hookConfig, callback) => {
        var hook = new Hook(hookConfig, 'beforeDelete')
        var hookError = {}

        Promise.resolve(hook.apply(current, hookError, this.schema, this.name, req)).then((newQuery) => {
          callback((newQuery === null) ? {} : null, newQuery)
        }).catch((err) => {
          callback(hook.formatError(err))
        })
      }, (err, result) => {
        if (err) {
          done(err)
        } else {
          deleteDocuments(database)
        }
      })
    } else {
      deleteDocuments(database)
    }
  }

  var deleteDocuments = (database) => {
    if (query._id) {
      query._id = query._id.toString()
    }

    var wait = Promise.resolve()

    if (this.history) {
      wait = new Promise((resolve, reject) => {
        this.find(query, { compose: false }, (err, docs) => {
          if (err) return reject(err)

          var deletedDocs = docs.results

          // for each of the about-to-be-deleted documents, create a revision for it
          if (deletedDocs.length > 0) {
            this.history.createEach(deletedDocs, 'delete', this).then(() => {
              return resolve()
            }).catch((err) => {
              return reject(err)
            })
          } else {
            return resolve()
          }
        })
      })
    }

    wait.then(() => {
      // query = queryUtils.convertApparentObjectIds(query, this.schema)

      database.delete(query, this.name, this.schema).then((result) => {
        if (!err && (result.deletedCount > 0)) {
          // apply any existing `afterDelete` hooks
          if (this.settings.hasOwnProperty('hooks') && (typeof this.settings.hooks.afterDelete === 'object')) {
            this.settings.hooks.afterDelete.forEach((hookConfig, index) => {
              var hook = new Hook(this.settings.hooks.afterDelete[index], 'afterDelete')

              return hook.apply(query, this.schema, this.name)
            })
          }
        }

        done(null, result.deletedCount)
      })
    }).catch((err) => {
      done(err)
    })
  }

  if (this.connection.db) return startDelete(this.connection.db)

  // if the db is not connected queue the delete
  this.connection.once('connect', startDelete)
}

function validationError (message) {
  var err = new Error(message || 'Model Validation Failed')
  err.statusCode = 400
  return err
}

// exports
module.exports = function (name, schema, conn, settings) {
  if (schema) return new Model(name, schema, conn, settings)
  return _models[name]
}

module.exports.Model = Model
