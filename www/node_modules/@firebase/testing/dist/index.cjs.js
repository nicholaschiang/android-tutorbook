'use strict';

Object.defineProperty(exports, '__esModule', { value: true });

var firebase = require('firebase');
var request = require('request');
var util = require('@firebase/util');
var logger = require('@firebase/logger');
var grpc = require('grpc');
var protoLoader = require('@grpc/proto-loader');
var path = require('path');

/**
 * @license
 * Copyright 2018 Google Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
var PROTO_ROOT = path.resolve(__dirname, "src/protos" );
var PROTO_FILE = path.resolve(PROTO_ROOT, 'google/firestore/emulator/v1/firestore_emulator.proto');
var PKG_DEF = protoLoader.loadSync(PROTO_FILE, { includeDirs: [PROTO_ROOT] });
var PROTOS = grpc.loadPackageDefinition(PKG_DEF);
var EMULATOR = PROTOS['google']['firestore']['emulator']['v1'];
/** If this environment variable is set, use it for the database emulator's address. */
var DATABASE_ADDRESS_ENV = 'FIREBASE_DATABASE_EMULATOR_ADDRESS';
/** The default address for the local database emulator. */
var DATABASE_ADDRESS_DEFAULT = 'localhost:9000';
/** The actual address for the database emulator */
var DATABASE_ADDRESS = process.env[DATABASE_ADDRESS_ENV] || DATABASE_ADDRESS_DEFAULT;
/** If any of environment variable is set, use it for the Firestore emulator. */
var FIRESTORE_ADDRESS_ENVS = [
    'FIRESTORE_EMULATOR_HOST',
    'FIREBASE_FIRESTORE_EMULATOR_ADDRESS'
];
/** The default address for the local Firestore emulator. */
var FIRESTORE_ADDRESS_DEFAULT = 'localhost:8080';
/** The actual address for the Firestore emulator */
var FIRESTORE_ADDRESS = FIRESTORE_ADDRESS_ENVS.reduce(function (addr, name) { return process.env[name] || addr; }, FIRESTORE_ADDRESS_DEFAULT);
/** Passing this in tells the emulator to treat you as an admin. */
var ADMIN_TOKEN = 'owner';
/** Create an unsecured JWT for the given auth payload. See https://tools.ietf.org/html/rfc7519#section-6. */
function createUnsecuredJwt(auth) {
    // Unsecured JWTs use "none" as the algorithm.
    var header = {
        alg: 'none',
        kid: 'fakekid'
    };
    // Ensure that the auth payload has a value for 'iat'.
    auth.iat = auth.iat || 0;
    // Use `uid` field as a backup when `sub` is missing.
    auth.sub = auth.sub || auth.uid;
    if (!auth.sub) {
        throw new Error("auth must be an object with a 'sub' or 'uid' field");
    }
    // Unsecured JWTs use the empty string as a signature.
    var signature = '';
    return [
        util.base64.encodeString(JSON.stringify(header), /*webSafe=*/ false),
        util.base64.encodeString(JSON.stringify(auth), /*webSafe=*/ false),
        signature
    ].join('.');
}
function apps() {
    return firebase.apps;
}
/** Construct an App authenticated with options.auth. */
function initializeTestApp(options) {
    return initializeApp(options.auth ? createUnsecuredJwt(options.auth) : undefined, options.databaseName, options.projectId);
}
/** Construct an App authenticated as an admin user. */
function initializeAdminApp(options) {
    return initializeApp(ADMIN_TOKEN, options.databaseName, options.projectId);
}
function initializeApp(accessToken, databaseName, projectId) {
    var appOptions = {};
    if (databaseName) {
        appOptions['databaseURL'] = "http://" + DATABASE_ADDRESS + "?ns=" + databaseName;
    }
    if (projectId) {
        appOptions['projectId'] = projectId;
    }
    var appName = 'app-' + new Date().getTime() + '-' + Math.random();
    var app = firebase.initializeApp(appOptions, appName);
    // hijacking INTERNAL.getToken to bypass FirebaseAuth and allows specifying of auth headers
    if (accessToken) {
        app.INTERNAL.getToken = function () {
            return Promise.resolve({ accessToken: accessToken });
        };
    }
    if (databaseName) {
        // Toggle network connectivity to force a reauthentication attempt.
        // This mitigates a minor race condition where the client can send the
        // first database request before authenticating.
        app.database().goOffline();
        app.database().goOnline();
    }
    if (projectId) {
        app.firestore().settings({
            host: FIRESTORE_ADDRESS,
            ssl: false
        });
    }
    /**
    Mute warnings for the previously-created database and whatever other
    objects were just created.
   */
    logger.setLogLevel(logger.LogLevel.ERROR);
    return app;
}
function loadDatabaseRules(options) {
    if (!options.databaseName) {
        throw Error('databaseName not specified');
    }
    if (!options.rules) {
        throw Error('must provide rules to loadDatabaseRules');
    }
    return new Promise(function (resolve, reject) {
        request.put({
            uri: "http://" + DATABASE_ADDRESS + "/.settings/rules.json?ns=" + options.databaseName,
            headers: { Authorization: 'Bearer owner' },
            body: options.rules
        }, function (err, resp, body) {
            if (err) {
                reject(err);
            }
            else if (resp.statusCode !== 200) {
                reject(JSON.parse(body).error);
            }
            else {
                resolve();
            }
        });
    });
}
function loadFirestoreRules(options) {
    if (!options.projectId) {
        throw new Error('projectId not specified');
    }
    if (!options.rules) {
        throw new Error('must provide rules to loadFirestoreRules');
    }
    var client = new EMULATOR.FirestoreEmulator(FIRESTORE_ADDRESS, grpc.credentials.createInsecure());
    return new Promise(function (resolve, reject) {
        client.setSecurityRules({
            project: "projects/" + options.projectId,
            rules: { files: [{ content: options.rules }] }
        }, 
        // @ts-ignore Defined in protobuf.
        function (err, resp) {
            if (err) {
                reject(err);
            }
            else {
                resolve(resp);
            }
        });
    });
}
function clearFirestoreData(options) {
    if (!options.projectId) {
        throw new Error('projectId not specified');
    }
    var client = new EMULATOR.FirestoreEmulator(FIRESTORE_ADDRESS, grpc.credentials.createInsecure(), {
        // As with 'loadFirestoreRules', cap how much backoff gRPC will perform.
        'grpc.initial_reconnect_backoff_ms': 100,
        'grpc.max_reconnect_backoff_ms': 100
    });
    return new Promise(function (resolve, reject) {
        client.clearData({
            database: "projects/" + options.projectId + "/databases/(default)"
        }, 
        // @ts-ignore Defined in protobuf.
        function (err, resp) {
            if (err) {
                reject(err);
            }
            else {
                resolve(resp);
            }
        });
    });
}
function assertFails(pr) {
    return pr.then(function (v) {
        return Promise.reject(new Error('Expected request to fail, but it succeeded.'));
    }, function (err) { return err; });
}
function assertSucceeds(pr) {
    return pr;
}

Object.defineProperty(exports, 'database', {
  enumerable: true,
  get: function () {
    return firebase.database;
  }
});
Object.defineProperty(exports, 'firestore', {
  enumerable: true,
  get: function () {
    return firebase.firestore;
  }
});
exports.apps = apps;
exports.assertFails = assertFails;
exports.assertSucceeds = assertSucceeds;
exports.clearFirestoreData = clearFirestoreData;
exports.initializeAdminApp = initializeAdminApp;
exports.initializeTestApp = initializeTestApp;
exports.loadDatabaseRules = loadDatabaseRules;
exports.loadFirestoreRules = loadFirestoreRules;
//# sourceMappingURL=index.cjs.js.map
