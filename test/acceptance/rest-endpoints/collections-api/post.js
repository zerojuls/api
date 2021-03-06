const should = require('should')
const sinon = require('sinon')
const fs = require('fs')
const path = require('path')
const request = require('supertest')
const _ = require('underscore')
const config = require(__dirname + '/../../../../config')
const help = require(__dirname + '/../../help')
const app = require(__dirname + '/../../../../dadi/lib/')

// variables scoped for use throughout tests
const connectionString = 'http://' + config.get('server.host') + ':' + config.get('server.port')
let bearerToken
let lastModifiedAt = 0

describe('Collections API – POST', function () {
  this.timeout(4000)

  let cleanupFn

  before(function (done) {
    help.dropDatabase('testdb', function (err) {
      if (err) return done(err)

      app.start(function () {
        help.getBearerTokenWithAccessType('admin', function (err, token) {
          if (err) return done(err)

          bearerToken = token

          let schema = {
            "fields": {
              "field1": {
                "type": "String",
                "required": false
              },
              "field2": {
                "type": "Number",
                "required": false
              },
              "field3": {
                "type": "ObjectID",
                "required": false
              },
              "_fieldWithUnderscore": {
                "type": "Object",
                "required": false
              }
            },
            "settings": {}
          }

          help.writeTempFile(
            'temp-workspace/collections/vtest/testdb/collection.test-schema.json',
            schema,
            callback1 => {
              help.writeTempFile(
                'temp-workspace/collections/v1/testdb/collection.test-schema.json',
                schema,
                callback2 => {
                  cleanupFn = () => {
                    callback1()
                    callback2()
                  }

                  done()
                }
              )
            }
          )
        })
      })
    })
  })

  after(function (done) {
    app.stop(() => {
      cleanupFn()
      done()
    })
  })

  it('should create new documents', function (done) {
    var client = request(connectionString)
    client
      .post('/vtest/testdb/test-schema')
      .set('Authorization', 'Bearer ' + bearerToken)
      .send({field1: 'foo!'})
      .expect(200)
      .end(function (err, res) {
        if (err) return done(err)

        should.exist(res.body.results)
        res.body.results.should.be.Array
        res.body.results.length.should.equal(1)
        should.exist(res.body.results[0]._id)
        res.body.results[0].field1.should.equal('foo!')
        done()
      })
  })

  it('should create new documents and return its representation containing the internal fields prefixed with the character defined in config', function (done) {
    var originalPrefix = config.get('internalFieldsPrefix')

    config.set('internalFieldsPrefix', '$')

    var client = request(connectionString)
    client
      .post('/vtest/testdb/test-schema')
      .set('Authorization', 'Bearer ' + bearerToken)
      .send({field1: 'foo!'})
      .expect(200)
      .end(function (err, res) {
        if (err) return done(err)

        res.body.results.should.be.Array
        res.body.results.length.should.equal(1)
        should.not.exist(res.body.results[0]._id)
        should.exist(res.body.results[0].$id)
        should.exist(res.body.results[0].$createdAt)
        should.exist(res.body.results[0].$createdBy)
        res.body.results[0].field1.should.equal('foo!')

        config.set('internalFieldsPrefix', originalPrefix)

        done()
      })
  })

  it('should create new documents when body is urlencoded', function (done) {
    var body = 'field1=foo!'
    var client = request(connectionString)

    client
      .post('/vtest/testdb/test-schema')
      .set('Authorization', 'Bearer ' + bearerToken)
      .send(body)
      .expect(200)
      .end(function (err, res) {
        if (err) return done(err)

        should.exist(res.body.results)

        res.body.results.should.be.Array
        res.body.results.length.should.equal(1)
        should.exist(res.body.results[0]._id)
        should.exist(res.body.results[0].field1)
        res.body.results[0].field1.should.equal('foo!')
        done()
      })
  })

  it('should create new documents when content-type is text/plain', function (done) {
    var body = JSON.stringify({
      field1: 'foo!'
    })

    var client = request(connectionString)

    client
      .post('/vtest/testdb/test-schema')
      .set('Authorization', 'Bearer ' + bearerToken)
      .set('content-type', 'text/plain')
      .send(body)
      .expect(200)
      .end(function (err, res) {
        if (err) return done(err)

        should.exist(res.body.results)

        res.body.results.should.be.Array
        res.body.results.length.should.equal(1)
        should.exist(res.body.results[0]._id)
        should.exist(res.body.results[0].field1)
        res.body.results[0].field1.should.equal('foo!')
        done()
      })
  })

  it('should create new documents when content-type includes a charset', function (done) {
    var body = JSON.stringify({
      field1: 'foo!'
    })

    var client = request(connectionString)

    client
      .post('/vtest/testdb/test-schema')
      .set('Authorization', 'Bearer ' + bearerToken)
      .set('content-type', 'application/json; charset=UTF-8')
      .send(body)
      .expect(200)
      .end(function (err, res) {
        if (err) return done(err)

        should.exist(res.body.results)

        res.body.results.should.be.Array
        res.body.results.length.should.equal(1)
        should.exist(res.body.results[0]._id)
        should.exist(res.body.results[0].field1)
        res.body.results[0].field1.should.equal('foo!')
        done()
      })
  })

  it('should create new documents with ObjectIDs from single value', function (done) {
    var body = { field1: 'foo!', field2: 1278, field3: '55cb1658341a0a804d4dadcc' }
    var client = request(connectionString)
    client
      .post('/vtest/testdb/test-schema')
      .set('Authorization', 'Bearer ' + bearerToken)
      .send(body)
      .expect(200)
      .end(function (err, res) {
        if (err) return done(err)

        should.exist(res.body.results)

        res.body.results.should.be.Array
        res.body.results.length.should.equal(1)
        should.exist(res.body.results[0]._id)
        should.exist(res.body.results[0].field3)
        // (typeof res.body.results[0].field3).should.equal('object')

        done()
      })
  })

  it('should create new documents with ObjectIDs from array', function (done) {
    var body = { field1: 'foo!', field2: 1278, field3: ['55cb1658341a0a804d4dadcc', '55cb1658341a0a804d4dadff'] }
    var client = request(connectionString)
    client
      .post('/vtest/testdb/test-schema')
      .set('Authorization', 'Bearer ' + bearerToken)
      .send(body)
      .expect(200)
      .end(function (err, res) {
        if (err) return done(err)

        should.exist(res.body.results)

        res.body.results.should.be.Array
        res.body.results.length.should.equal(1)
        should.exist(res.body.results[0]._id)
        should.exist(res.body.results[0].field3)
        // (typeof res.body.results[0].field3).should.equal('object')

        done()
      })
  })

  it('should add internal fields to new documents', function (done) {
    var client = request(connectionString)
    client
      .post('/vtest/testdb/test-schema')
      .set('Authorization', 'Bearer ' + bearerToken)
      .send({field1: 'foo!'})
      .expect(200)
      .end(function (err, res) {
        if (err) return done(err)

        should.exist(res.body.results)

        res.body.results.should.be.Array
        res.body.results.length.should.equal(1)
        res.body.results[0]._createdBy.should.equal('test123')
        res.body.results[0]._createdAt.should.be.Number
        res.body.results[0]._createdAt.should.not.be.above(Date.now())
        res.body.results[0]._apiVersion.should.equal('vtest')
        done()
      })
  })

  it('should return 404 when updating a non-existing document by ID (RESTful)', function (done) {
    var client = request(connectionString)

    client
      .post('/vtest/testdb/test-schema/59f1b3e038ad765e669ac47f')
      .set('Authorization', 'Bearer ' + bearerToken)
      .send({field1: 'updated doc'})
      .expect(404)
      .end(function (err, res) {
        if (err) return done(err)

        res.body.statusCode.should.eql(404)

        done()
      })
  })

  it('should return 200 when updating a non-existing document by ID, supplying the query in the request body', function (done) {
    var client = request(connectionString)

    client
      .post('/vtest/testdb/test-schema')
      .set('Authorization', 'Bearer ' + bearerToken)
      .send({
        query: {
          _id: '59f1b3e038ad765e669ac47f'
        },
        update: {
          field1: 'updated doc'
        }
      })
      .expect(200)
      .end(function (err, res) {
        if (err) return done(err)

        res.body.results.should.eql([])

        done()
      })
  })
})
