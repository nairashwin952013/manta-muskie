/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

var assert = require('assert-plus');
var libmanta = require('libmanta');
var libuuid = require('libuuid');
var path = require('path');
var restify = require('restify');
var util = require('util');
var vasync = require('vasync');
var verror = require('verror');

var sprintf = util.format;

var common = require('../common');
var obj = require('../obj');
var uploadsCommon = require('./common');
require('../errors');


///--- Helpers

/*
 * Selects the sharks for the upload through the picker.choose interface.
 *
 * The number of sharks needed and the size of the sharks are specified by
 * the durability-level and the content-length headers, respectively, or
 * set to a default value.
 */
function chooseSharks(req, size, copies, cb) {
    var log = req.log;

    if (size === 0) {
        cb(null, {});
    } else {
        var opts = {
            requestId: req.getId(),
            replicas: copies,
            size: size
        };
        req.picker.choose(opts, function (err, sharks) {
            if (err) {
                cb(err);
            } else {
                log.info('upload: sharks chosen');
                cb(null, sharks[0]);
            }
        });
    }
}


///--- API

// Instantiates the uploads object.
function setupUpload(req, res, next) {
    var id = libuuid.create();
    req.upload = new uploadsCommon.MultipartUpload(req, id);

    next();
}

/*
 * Validates that all parameters needed for creating an upload exist, including:
 *   - objectPath (the final path the uploaded object resides)
 *
 * Also validates optional headers, if they exist:
 *   - durability-level
 *   - content-length
 *   - content-md5
 *
 * This handler is expected to set the following state on the upload object:
 * - objectPath
 * - size
 * - copies
 * - headers
 * - contentMD5
 * - contentType
 */
function validateParams(req, res, next) {
    if (!req.body.objectPath) {
        next(new MultipartUploadMissingObjecPathError());
    } else {
        var headers, size, copies;

        headers = req.body.headers || {};
        var maxObjectCopies = req.config.maxObjectCopies;

        size = parseInt((headers['content-length'] ||
            obj.DEF_MAX_LEN), 10);
        if (size < 0) {
            next(new MaxContentLengthError(size));
            return;
        }

        copies = parseInt((headers['x-durability-level'] || 2), 10);
        if (copies < 1 || copies > (maxObjectCopies || 9)) {
            next(new InvalidDurabilityLevelError(1, maxObjectCopies));
            return;
        }

        req.upload._headers = headers;
        req.upload._size = size;
        req.upload._copies = copies;

        req.log.info('parameters valid');

        next();
    }
}


/*
 * Checks if the parent of the upload directory exists, and if it doesn't,
 * creates the directory.
 *
 * For example,if the prefix length for an upload ID is 1, and the id is abcdef,
 * the prefix directory is of the form: /account/uploads/a.
 */
function ensurePrefixDir(req, res, next) {
    var log = req.log;
    var requestId = req.getId();
    var id = req.upload.id;
    log.info('creating upload ' + id + ' for path: \"' +
        req.body.objectPath + '\"');

    var parentOpts = {
        key: path.dirname(req.upload.uploadPathKey()),
        requestId: requestId
    };
    log.info('upload path directory key: ' + parentOpts.key);

    req.moray.getMetadata(parentOpts, function (err, md, _) {
        if (err) {
            if (verror.hasCauseWithName(err, 'ObjectNotFoundError')) {
                // If the directory doesn't exist yet, create it.
                parentOpts.dirname = path.dirname(parentOpts.key);
                parentOpts.mtime = Date.now();
                parentOpts.owner = req.owner.account.uuid;
                parentOpts.requestId = req.getId();
                parentOpts.type = 'directory';
                //TODO: headers, roles, _etag

                req.moray.putMetadata(parentOpts, function (err2) {
                    if (err2) {
                        next(err2);
                    } else {
                        //TODO: need to save parent metadata here?
                        log.info('prefix directory \"' + parentOpts.key +
                            '\" created');
                        next();
                    }
                });
            } else {
                next(err);
            }
        } else {
            log.info('prefix directory \"' + parentOpts.key +
                '\" already created');
            next();
        }
    });
}


/*
 * Actually create the upload in the sense that the upload record exists.
 * To do so, we must first choose the sharks that the final object will
 * live on and save the metadata for the upload record.
 */
function createUpload(req, res, next) {
    var s = req.upload._size;
    var c = req.upload._copies;

    chooseSharks(req, s, c, function (err, sharks) {
        if (err) {
            next(err);
        } else {
            var opts = {
                objectPath: req.body.objectPath,
                sharks: sharks,
                headers: req.body.headers || {}
            };
            req.upload.createUpload(opts, function (err2, partsDirectory) {
                    if (err2) {
                        next(err2);
                    } else {
                        req.log.info('responding OK for upload ' +
                            req.upload.id);
                        res.send(201, {
                            id: req.upload.id,
                            partsDirectory: partsDirectory
                        });
                        next();
                    }
            });
        }
    });
}


///--- Exports

module.exports = {
    createHandler: function createHandler() {
        var chain = [
            restify.jsonBodyParser({
                mapParams: false,
                maxBodySize: 100000
            }),
            setupUpload,
            validateParams,
            ensurePrefixDir,
            createUpload
        ];
        return (chain);
    }
};