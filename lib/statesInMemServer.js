/**
 * @fileOverview
 * @author hobbyquaker
 * @version 0.1
 */

/** @module statesRedis */

/* jshint -W097 */// jshint strict:false
/*jslint node: true */
"use strict";

var socketio = require('socket.io');
var fs       = require('fs');

function StatesInMemory(settings) {
    settings = settings || {};

    var change =             settings.change;

    var states =            {};
    var objects =           {};
    var fifo =              {};
    var messagebox =        {};
    var logs =              {};
    var session =           {};
    var globalMessageId =   0;

    var expires =           [];
    var lastExpire =        null;
    var expiresInterval =   null;

    var dataDir = settings.dataDir || (__dirname + '/../data');
    dataDir = dataDir.replace(/\\/g, '/');
    if (dataDir[dataDir.length - 1] != '/') dataDir += '/'

    var objectsName = dataDir + 'objects.json';
    var objectsDir  = dataDir + 'files/';
    var statesName  = dataDir + 'states.json';
    var historyName = dataDir + 'history/';
    objectsName += 'objects.json';


    var stateTimer =        null;
    var configTimer =       null;

    var that =              this;

    var log = settings.logger;
    if (!log) {
        log = {
            info:  function (msg) {/*console.log(msg);*/},
            debug: function (msg) {/*console.log(msg);*/},
            warn:  function (msg) {
                console.log(msg);
            },
            error: function (msg) {
                console.log(msg);
            }
        };
    }

    var server = {
        app:       null,
        server:    null,
        io:        null,
        settings:  settings
    };

    var __construct = (function () {

        // load values from file
        if (fs.existsSync(statesName)) {
            try {
                states = JSON.parse(fs.readFileSync(statesName).toString());
            } catch (e) {
                log.error('Cannot parse ' + statesName + ': ' + e);
                if (fs.existsSync(statesName + '.bak')) {
                    try {
                        states = JSON.parse(fs.readFileSync(statesName + '.bak').toString());
                    } catch (e) {
                        log.error('Cannot parse ' + statesName + '.bak: ' + e);
                        states = {};
                    }
                } else {
                    states = {};
                }
            }
        } else if (fs.existsSync(statesName + '.bak')) {
            try {
                states = JSON.parse(fs.readFileSync(statesName + '.bak').toString());
            } catch (e) {
                log.error('Cannot parse ' + statesName + '.bak: ' + e);
                states = {};
            }
        } else {
            states = {};
        }

        if (fs.existsSync(objectsName)) {
            try {
                objects = JSON.parse(fs.readFileSync(objectsName).toString());
            } catch (e) {
                log.error('Cannot parse ' + objectsName + ': ' + e);
                if (fs.existsSync(objectsName + '.bak')) {
                    try {
                        objects = JSON.parse(fs.readFileSync(objectsName + '.bak').toString());
                    } catch (e) {
                        log.error('Cannot parse ' + objectsName + '.bak: ' + e);
                        objects = {};
                    }
                } else {
                    objects = {};
                }
            }
        } else if (fs.existsSync(objectsName + '.bak')) {
            try {
                objects = JSON.parse(fs.readFileSync(objectsName + '.bak').toString());
            } catch (e) {
                log.error('Cannot parse ' + objectsName + '.bak: ' + e);
                objects = {};
            }
        } else {
            objects = {};
        }

        // Reset expires, that are still in DB
        expireAll();

        // Check if diractory exists
        objectsName = objectsName.replace(/\\/g, '/');
        var parts = objectsName.split('/');
        parts.pop();
        parts = parts.join('/');
        if (!fs.existsSync(parts)) fs.mkdirSync(parts);

        _initWebServer(settings, server)

    })();

    function expireAll() {
        for (var i = 0, len = expires.length; i < len; i++) {
            var e = expires[i];
            states[e].ts  = Math.round((new Date()).getTime() / 1000);
            states[e].lc = (states[e].val) ? states[e].ts : states[e].lc;
            states[e].val = null;
            delete states[e].expire;
            that.publishAll('state', e, states[e]);
        }
        // Set as expire all states that could expire
        for (e in states) {
            if (states[e].expire !== undefined) {
                states[e].ts  = Math.round((new Date()).getTime() / 1000);
                states[e].lc = (states[e].val) ? states[e].ts : states[e].lc;
                states[e].val = null;
                delete states[e].expire;
            }
        }
        expires = [];
    }

    function expiresCheck() {
        var now = (new Date()).getTime();
        if (lastExpire !== null) {
            var diff = now - lastExpire;
            var count = 0;
            for (var i = 0, len = expires.length; i < len; i++) {
                var e = expires[i];
                states[e].expire -= diff;

                // if expired
                if (states[e].expire < 0) {
                    // Set value to null
                    states[e].ts  = Math.round((new Date()).getTime() / 1000);
                    states[e].lc  = (states[e].val) ? states[e].ts : states[e].lc;
                    states[e].val = null;
                    delete states[e].expire;
                    that.publishAll('state', e, states[e]);
                } else {
                    count++;
                }
            }

            for (e in session) {
                session[e]._expire -= diff;
                if (session[e]._expire < 0) {
                    delete session[e];
                } else {
                    count++;
                }
            }
            if (!count && expiresInterval) {
                clearInterval(expiresInterval);
                expiresInterval = null;
            }
        }
        lastExpire = now;
    }

    function pattern2RegEx(pattern) {
        pattern = pattern.replace(/\./g, '\\.');
        pattern = pattern.replace(/\*/g, '.*');
        return pattern;
    }

    function subscribe(socket, type, pattern) {
        socket._subscribe = socket._subscribe || {};
        var s = socket._subscribe[type] = socket._subscribe[type] || [];
        for (var i = 0; i < s.length; i++) {
            if (s[i].pattern == pattern) return;
        }

        s.push({pattern: pattern, regex: new RegExp(pattern2RegEx(pattern))});
    }

    function unsubscribe(socket, type, pattern) {
        if (!socket._subscribe || !socket._subscribe[type]) return;
        for (var i = 0; i < socket._subscribe[type].length; i++) {
            if (socket._subscribe[type][i].pattern == pattern) {
                delete socket._subscribe[type][i];
                return;
            }
        }
    }

    function publish(socket, type, id, obj) {
        if (!socket._subscribe || !socket._subscribe[type]) return;
        var s = socket._subscribe[type];
        for (var i = 0; i < s.length; i++) {
            if (s[i].regex.test(id)) {
                socket.emit("message", s[i].pattern, id, obj);
                return;
            }
        }
    }

    function saveState() {
        if (fs.existsSync(statesName)) {
            var old = fs.readFileSync(statesName);
            fs.writeFileSync(statesName + '.bak', old);
        }
        fs.writeFileSync(statesName, JSON.stringify(states));
        if (stateTimer) {
            clearTimeout(stateTimer);
            stateTimer = null;
        }
    }

    function saveConfig() {
        if (fs.existsSync(objectsName)) {
            var old = fs.readFileSync(objectsName);
            fs.writeFileSync(objectsName + '.bak', old);
        }
        fs.writeFileSync(objectsName, JSON.stringify(objects));
        if (configTimer) {
            clearTimeout(configTimer);
            configTimer = null;
        }
    }

    function socketEvents(socket, user) {
        /*
         *      states
         */
        socket.on('getStates', function (keys, callback, dontModify) {
            that.getStates.apply(that, arguments);
        });
        socket.on('getState', function (id, callback) {
            that.getState.apply(that, arguments);
        });
        socket.on('setState', function (id, state, callback) {
            that.setState.apply(that, arguments);
        });
        socket.on('setRawState', function (id, state, callback) {
            that.setRawState.apply(that, arguments);
        });
        socket.on('delState', function (id, callback) {
            that.delState.apply(that, arguments);
        });
        socket.on('getKeys', function (pattern, callback, dontModify) {
            that.getKeys.apply(that, arguments);
        });
        socket.on('subscribe', function (pattern) {
            that.subscribe.apply(this, arguments);
        });
        socket.on('unsubscribe', function (pattern) {
            that.unsubscribe.apply(this, arguments);
        });
        socket.on('pushFifoExists', function (id, state, callback) {
            that.pushFifoExists.apply(that, arguments);
        });
        socket.on('pushFifo', function (id, state, callback) {
            that.pushFifo.apply(that, arguments);
        });
        socket.on('lenFifo', function (id, callback) {
            that.lenFifo.apply(that, arguments);
        });
        socket.on('getFifo', function (id, callback) {
            that.getFifo.apply(that, arguments);
        });
        socket.on('getFifoRange', function (id, start, end, callback) {
            that.getFifoRange.apply(that, arguments);
        });
        socket.on('trimFifo', function (id, minLength, maxLength, callback) {
            that.trimFifo.apply(that, arguments);
        });
        socket.on('pushMessage', function (id, state, callback) {
            that.pushMessage.apply(that, arguments);
        });
        socket.on('lenMessage', function (id, callback) {
            that.lenMessage.apply(that, arguments);
        });
        socket.on('getMessage', function (id, callback) {
            that.getMessage.apply(that, arguments);
        });
        socket.on('delMessage', function (id, callback) {
            that.delMessage.apply(that, arguments);
        });
        socket.on('subscribeMessage', function (id) {
            that.subscribeMessage.apply(this, arguments);
        });
        socket.on('unsubscribeMessage', function (id) {
            that.unsubscribeMessage.apply(this, arguments);
        });
        socket.on('pushLog', function (id, state, callback) {
            that.pushLog.apply(that, arguments);
        });
        socket.on('lenLog', function (id, callback) {
            that.lenLog.apply(that, arguments);
        });
        socket.on('getLog', function (id, callback) {
            that.getLog.apply(that, arguments);
        });
        socket.on('subscribeLog', function (id) {
            that.subscribeLog.apply(this, arguments);
        });
        socket.on('unsubscribeLog', function (id) {
            that.unsubscribeLog.apply(this, arguments);
        });
        socket.on('getSession', function (id, callback) {
            that.getSession.apply(that, arguments);
        });
        socket.on('setSession', function (id, expire, obj, callback) {
            that.setSession.apply(that, arguments);
        });
        socket.on('destroySession', function (id, callback) {
            that.destroySession.apply(that, arguments);
        });
        socket.on('getConfig', function (id, callback) {
            that.getConfig.apply(that, arguments);
        });
        socket.on('getConfigKeys', function (pattern, callback, dontModify) {
            that.getConfigKeys.apply(that, arguments);
        });
        socket.on('getConfigs', function (keys, callback, dontModify) {
            that.getConfigs.apply(that, arguments);
        });
        socket.on('setConfig', function (id, obj, callback) {
            that.setConfig.apply(that, arguments);
        });
        socket.on('delConfig', function (id, callback) {
            that.delConfig.apply(that, arguments);
        });
        socket.on('subscribeConfig', function (pattern) {
            that.subscribeConfig.apply(this, arguments);
        });
        socket.on('unsubscribeConfig', function (pattern) {
            that.unsubscribeConfig.apply(this, arguments);
        });
        socket.on('setBinaryState', function (id, data, callback) {
            that.setBinaryState.apply(that, arguments);
        });
        socket.on('getBinaryState', function (id, callback) {
            that.getBinaryState.apply(that, arguments);
        });
        socket.on('delBinaryState', function (id, callback) {
            that.delBinaryState.apply(that, arguments);
        });
    }

    this.publishAll = function (type, id, obj) {
        var clients = server.io.sockets.connected;

        for (var i in clients) {
            publish(clients[i], type, id, obj);
        }

        if (change && this._subscribe && this._subscribe[type]) {
            for (var i = 0; i < this._subscribe[type].length; i++) {
                if (this._subscribe[type][i].regex.test(id)) {
                    setTimeout(function () {
                        change(id, obj);
                    }, 0);
                    break;
                }
            }
        }
    }

    this.destroy = function () {
        expireAll();
        if (stateTimer) {
            saveState();
        }
        if (configTimer) {
            saveConfig();
        }
    }

    this.getStates = function (keys, callback, dontModify) {
        if (!keys) {
            if (callback) callback('no keys', null);
            return;
        }
        if (!keys.length) {
            if (callback) callback(null, []);
            return;
        }
        var result = [];
        for (var i = 0; i < keys.length; i++) {
            result.push(states[keys[i]]);
        }
        if (typeof callback === 'function') callback(null, result);
    };

    this.getState = function (id, callback) {
        if (typeof callback == 'function') {
            callback(states[id]);
        }
    };

    this.setState = function (id, state, callback) {
        var that = this;
        var obj = {};

        if (typeof state !== 'object') {
            state = {
                val: state
            };
        }

        var oldObj = states[id];

        if (!oldObj) {
            oldObj = {};
        }

        if (state.val !== undefined) {
            obj.val = state.val;
        } else {
            obj.val = oldObj.val;
        }

        if (state.ack !== undefined) {
            obj.ack = state.ack;
        } else {
            obj.ack = false;
        }

        if (state.ts !== undefined) {
            obj.ts = state.ts;
        } else {
            obj.ts = Math.round((new Date()).getTime() / 1000);
        }

        obj.from = state.from;

        var hasChanged;

        if (state.lc !== undefined) {
            obj.lc = state.lc;
        } else {
            if (typeof obj.val === 'object') {
                hasChanged = JSON.stringify(oldObj.val) !== JSON.stringify(obj.val);
            } else {
                hasChanged = oldObj.val !== obj.val;
            }
            if (!oldObj.lc || hasChanged) {
                obj.lc = obj.ts;
            } else {
                obj.lc = oldObj.lc;
            }
        }

        // publish event in redis
        log.debug('redis publish ' + id + ' ' + JSON.stringify(obj));
        that.publishAll('state', id, obj);

        // set object in redis
        if (state.expire) {
            state.expire *= 1000; // make ms from seconds

            if (expires.indexOf(id) == -1) expires.push(id);

            if (!expiresInterval) {
                lastExpire = (new Date()).getTime();
                expiresInterval = setInterval(expiresCheck, 5000);
            } else {
                if (lastExpire) state.expire -= ((new Date()).getTime() - lastExpire);
            }
        }
        states[id] = obj;
        if (typeof callback === 'function') callback(id);
        if (!stateTimer) {
            stateTimer = setTimeout(saveState, 30000);
        }
     };

    this.setRawState = function (id, state, callback) {
        states[id] = state;
        if (typeof callback === 'function') callback(id);
    };

    this.delState = function (id, callback) {
        if (states[id]) {
            delete states[id];
            this.publishAll('state', id, null);
        }
        if (typeof callback === 'function') callback(id);
    };

    this.getKeys = function (pattern, callback, dontModify) {
        var r = new RegExp(pattern2RegEx(pattern));
        var result = [];
        for (var id in states) {
            if (r.test(id)) result.push(id);
        }
        if (typeof callback === 'function') callback(null, result);
    };

    this.subscribe = function (pattern) {
        subscribe(this, 'state', pattern);
    };

    this.unsubscribe = function (pattern) {
        unsubscribe(this, 'state', pattern);
    };

    this.pushFifoExists = function (id, state, callback) {
        if (fifo[id]) {
            fifo[id].push(state);
            if (typeof callback === 'function') callback(null, fifo[id]);
        } else {
            if (typeof callback === 'function') callback('Not exists', null);
        }
    };

    this.pushFifo = function (id, state, callback) {
        if (!fifo[id]) fifo[id] = [];
        fifo[id].push(state);
        if (typeof callback === 'function') callback(err, fifo[id]);
    };

    this.lenFifo = function (id, callback) {
        if (fifo[id]) {
            if (typeof callback === 'function') callback(null, fifo[id].length);
        } else {
            if (typeof callback === 'function') callback('Not exists', null);
        }
    };

    this.getFifo = function (id, callback) {
        if (fifo[id]) {
            if (typeof callback === 'function') callback(null, fifo[id]);
        } else {
            if (typeof callback === 'function') callback('Not exists', null);
        }
    };

    this.getFifoRange = function (id, start, end, callback) {
        if (fifo[id]) {
            var result = [];
            for (var i = start; i <= end; i++) {
                if (fifo[id][i]) result.push(fifo[id][i]);
            }

            if (typeof callback === 'function') callback(null, result);
        } else {
            if (typeof callback === 'function') callback('Not exists', null);
        }
    };

    this.trimFifo = function (id, minLength, maxLength, callback) {
        log.debug('trimFifo history.' + id + ' minLength=' + minLength + ' maxLength=' + maxLength);
        if (!fifo[id]) {
            if (typeof callback === 'function') callback('Not exists', null);
            return;
        }
        if (fifo[id].length <= maxLength) {
            if (typeof callback === 'function') callback(null, []);
        } else {
            var end = (minLength > fifo[id].length) ? minLength - fifo[id].length: 0;
            var result = fifo[id].splice(0, end - 1);
            if (typeof callback === 'function') callback(null, result);
        }
    };

    this.pushMessage = function (id, state, callback) {
        messagebox[id] = messagebox[id] || [];
        state._id = globalMessageId++;
        messagebox[id].push(state);
        that.publishAll('messagebox', 'messagebox.' + id, state);
        if (typeof callback === 'function') callback(null, id);
    };

    this.lenMessage = function (id, callback) {
        if (messagebox[id]) {
            if (typeof callback === 'function') callback(null, messagebox[id].length);
        } else {
            if (typeof callback === 'function') callback('Not exists', null);
        }
    };

    this.getMessage = function (id, callback) {
        if (messagebox[id]) {
            if (typeof callback === 'function') callback(null, messagebox[id].shift());
        } else {
            if (typeof callback === 'function') callback('Not exists', null);
        }
    };

    this.delMessage = function (id, messageId) {
        if (messagebox[id]) {
            var found = false;
            for (var i = 0; i < messagebox[id].length; i++) {
                if (messagebox[id][i]._id == messageId) {
                    messagebox[id].splice(i, 1);
                    found = true;
                    break;
                }
            }
            if (!found) {
                console.log('WARNING: cannot find message with id = ' + messageId);
                log.error('WARNING: cannot find message with id = ' + messageId);
            }
        }
    };

    this.subscribeMessage = function (id) {
        subscribe(this, 'messagebox', 'messagebox.' + id);
    };

    this.unsubscribeMessage = function (id) {
        unsubscribe(this, 'messagebox', 'messagebox.' + id);
    };

    this.pushLog = function (id, state, callback) {
        logs[id] = logs[id] || [];
        logs[id].push(state);
        that.publishAll('log', 'log.' + id, state);
        if (typeof callback === 'function') callback(null, id);
    };

    this.lenLog = function (id, callback) {
        if (logs[id]) {
            if (typeof callback === 'function') callback(null, logs[id].length);
        } else {
            if (typeof callback === 'function') callback('Not exists', null);
        }
    };

    this.getLog = function (id, callback) {
        if (logs[id]) {
            if (typeof callback === 'function') callback(null, logs[id].shift());
        } else {
            if (typeof callback === 'function') callback('Not exists', null);
        }
    };

    this.subscribeLog = function (id) {
        subscribe(this, 'log', 'log.' + id);
    };

    this.unsubscribeLog = function (id) {
        unsubscribe(this, 'log', 'log.' + id);
    };

    this.getSession = function (id, callback) {
        if (typeof callback === 'function') callback(session[id]);
    };

    this.setSession = function (id, expire, obj, callback) {
        session[id] = obj || {};
        session[id]._expire = expire * 1000;
        if (!expiresInterval) {
            lastExpire = (new Date()).getTime();
            expiresInterval = setInterval(expiresCheck, 5000);
        } else {
            if (lastExpire) session[id]._expire -= ((new Date()).getTime() - lastExpire);
        }

        if (typeof callback === 'function') callback();
    };

    this.destroySession = function (id, callback) {
        if (session[id]) {
            delete session[id];
        }
        if (typeof callback === 'function')  callback();
    };

    this.getConfig = function (id, callback) {
        if (typeof callback === 'function') callback(null, objects[id]);
    };

    this.getConfigKeys = function (pattern, callback, dontModify) {
        var r = new RegExp(pattern2RegEx(pattern));
        var result = [];
        for (var id in objects) {
            if (r.test(id)) result.push(id);
        }
        if (typeof callback === 'function') callback(null, result);
    };

    this.getConfigs = function (keys, callback, dontModify) {
        if (!keys) {
            if (callback) callback('no keys', null);
            return;
        }
        if (!keys.length) {
            if (callback) callback(null, []);
            return;
        }
        var result = [];
        for (var i = 0; i < keys.length; i++) {
            result.push(objects[keys[i]]);
        }
        if (typeof callback === 'function') callback(null, result);
    };

    this.setConfig = function (id, obj, callback) {
        objects[id] = obj;
        that.publishAll('objects', id, obj);
        if (typeof callback === 'function') callback(null, {id: id});
        if (!configTimer) configTimer = setTimeout(saveConfig, 5000);
    };

    this.delConfig = function (id, callback) {
        if (objects[id]) {
            delete objects[id];
            that.publishAll('objects', id, null);
            if (typeof callback === 'function') callback(null);
        } else {
            if (typeof callback === 'function') callback('Not exists');
        }
    };

    this.subscribeConfig = function (pattern) {
        subscribe(this, 'objects', pattern);
    };

    this.unsubscribeConfig = function (pattern) {
        unsubscribe(this, 'objects', pattern);
    };

    this.setBinaryState = function (id, data, callback) {
        states[id] = data;
        if (typeof callback === 'function') callback(nul);
        if (!stateTimer) stateTimer = setTimeout(saveState, 30000);
    };

    this.getBinaryState = function (id, callback) {
        if (states[id]) {
            if (callback) callback(null, states[id]);
        } else {
            if (callback) callback('Not exists');
        }
    };

    this.delBinaryState = function (id, callback) {
        if (states[id]) {
            delete states[id];
        }
        if (typeof callback === 'function')  callback();
    };
    
    function initSocket(socket) {
        if (settings.auth) {
            var user = null;
            socketEvents(socket, user);
        } else {
            socketEvents(socket);
        }
    }

    function _initWebServer(settings, server) {

        if (settings.secure) {
            if (!settings.certificates) return;
            server.server = require('https').createServer(settings.certificates, function (req, res) {
                res.writeHead(501);
                res.end('Not Implemented');
            }).listen(settings.port || 9000, (settings.bind && settings.bind != "0.0.0.0") ? settings.bind : undefined);
        } else {
            server.server = require('http').createServer(function (req, res) {
                res.writeHead(501);
                res.end('Not Implemented');
            }).listen(settings.port || 9000, (settings.bind && settings.bind != "0.0.0.0") ? settings.bind : undefined);
        }

        server.io = socketio.listen(server.server);

//    server.io = socketio.listen(settings.port, (settings.bind && settings.bind != "0.0.0.0") ? settings.bind : undefined);

        if (settings.auth) {

            server.io.use(function (socket, next) {
                if (!socket.request._query.user || !socket.request._query.pass) {
                    console.log("No password or username!");
                    next(new Error('Authentication error'));
                } else {
                    adapter.checkPassword(socket.request._query.user, socket.request._query.pass, function (res) {
                        if (res) {
                            console.log("Logged in: " + socket.request._query.user + ', ' + socket.request._query.pass);
                            return next();
                        } else {
                            console.log("Invalid password or user name: " + socket.request._query.user + ', ' + socket.request._query.pass);
                            next(new Error('Invalid password or user name'));
                        }
                    });
                }
            });
        }
        server.io.set('origins', '*:*');
        server.io.on('connection', initSocket);

        log.info((settings.secure ? 'Secure ' : '') + 'inMem-states listening on port ' + (settings.port || 9000));
    }

}

module.exports = StatesInMemory;