/*
 * Copyright (c) 2012 Adobe Systems Incorporated and other contributors.
 * All rights reserved.
 *  
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"), 
 * to deal in the Software without restriction, including without limitation 
 * the rights to use, copy, modify, merge, publish, distribute, sublicense, 
 * and/or sell copies of the Software, and to permit persons to whom the 
 * Software is furnished to do so, subject to the following conditions:
 *  
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *  
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, 
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER 
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING 
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER 
 * DEALINGS IN THE SOFTWARE.
 * 
 */

/*jslint vars: true, plusplus: true, devel: true, nomen: true, indent: 4, maxerr: 50 */
/*global define */

/**
 * Your connection to the browser-side instrumentation code.
 *
 * Provides these events:
 *
 *   - receivedScriptInfo (path):
 *       when information about functions and call sites has been received
 */

define(function (require, exports, module) {
    var DOMAgent       = brackets.getModule("LiveDevelopment/Agents/DOMAgent");
    var ExtensionUtils = brackets.getModule("utils/ExtensionUtils");
    var Fsm            = require("fsm").Fsm;
    var Inspector      = brackets.getModule("LiveDevelopment/Inspector/Inspector");
    var Util           = require("Util");

    var $exports = $(exports);

    var _proxyURL;
    var _tracerObjectId;
    var _defaultTrackingHandle;
    var _queuedScripts;

    // instrumentation data
    var _nodes = {}; // id (string) -> {id: string, path: string, start: {line, column}, end: {line, column}, name: string (optional)}
    var _nodesByFilePath = {};
    var _invocations = {}; // id (string) -> {id: string, f: function (see above), children: [invocation id], parents: [invocation id]}
    var _nodeHitCounts = {};

    var fsm = new Fsm({
        waitingForProxy: {
            enter:                 function () { _resetAll(); _startProxy(); },
            proxyStarted:          function () { this.goto("disconnected"); },
        },
        disconnected: {
            enter:                 function () { _resetConnection(); },
            inspectorConnected:    function () { this.goto("waitingForPage"); },
        },
        waitingForPage: {
            enter:                 function () { _resetConnection(); },
            gotDocument:           function () { this.goto("initializingTracer"); },
            inspectorDisconnected: function () { this.goto("disconnected"); },
        },
        initializingTracer: {
            enter:                 function () { _resetConnection(); _connectToTracer(); },
            tracerConnected:       function () { this.goto("initializingHits"); },
            tracerConnectFailed:   function () { this.goto("disconnected"); },

            gotDocument:           function () { this.goto("initializingTracer"); }, // XXX: I think this case is tricky
            inspectorDisconnected: function () { this.goto("disconnected"); },
        },
        initializingHits: {
            enter:                 function () { _trackHits(); },
            trackingHits:          function () { this.goto("connected"); },
            trackingHitsFailed:    function () { this.goto("disconnected"); },

            gotDocument:           function () { this.goto("initializingTracer"); }, // XXX: I think this case is tricky
            inspectorDisconnected: function () { this.goto("disconnected"); },
        },
        connected: {
            enter:                 function () { $exports.triggerHandler("connect"); _sendQueuedEvents(); },
            exit:                  function () { $exports.triggerHandler("disconnect"); },

            gotDocument:           function () { this.goto("initializingTracer"); },
            inspectorDisconnected: function () { this.goto("disconnected"); },
        },
    }, "waitingForProxy");

    function _startProxy() {
        var _nodeConnection = new brackets.NodeConnection();
        _nodeConnection.connect(true).then(function () {
            _nodeConnection.loadDomains(
                [ExtensionUtils.getModulePath(module, "proxy/ProxyDomain")],
                true
            ).then(function () {
                _nodeConnection.domains.connect.startServer("/").then(function (address) {
                    _proxyPrefix = "http://" + address.address + ":" + address.port;
                    fsm.trigger("proxyStarted");
                });
            });
        });
        $(_nodeConnection).on(
            "base.log",
            function (evt, level, timestamp, message) {
                console.log("[theseus proxy]", {
                    level: level,
                    timestamp: timestamp,
                    message: message
                });
            }
        );
    }

    /** event handler for when a new page is loaded **/
    function _gotDocument(e, res) {
        fsm.trigger("gotDocument");
    }

    function _connectToTracer() {
        Inspector.Runtime.evaluate("tracer.connect()", function (res) {
            if (!res.wasThrown) {
                _tracerObjectId = res.result.objectId;
                fsm.trigger("tracerConnected");
            } else {
                console.log("failed to get tracer instance", res);
                fsm.trigger("tracerConnectFailed");
            }
        });
    }

    function _trackHits() {
        trackHits(function (handle) {
            if (handle === undefined) {
                fsm.trigger("trackingHitsFailed");
            } else {
                _defaultTrackingHandle = handle;
                fsm.trigger("trackingHits");
            }
        });
    }

    /**
     * WebInspector event: DOM.attributeModified
     *
     * The page sends Brackets events by putting message data into DOM
     * attributes whose names match the pattern data-tracer-*
     *
     * @param res is an object with keys nodeId, name, and value
     */
    function _onAttributeModified(event, res) {
        if (res.name === 'data-tracer-scripts-added') {
            var data = JSON.parse(res.value);
            _addNodes(data.nodes);

            // de-dup paths, then send receivedScriptInfo event for each one
            var pathsO = {};
            for (var i in data.nodes) { pathsO[data.nodes[i].path] = true; }
            for (var path in pathsO) {
                _triggerReceivedScriptInfo(path);
            }
        }
    }

    function _triggerReceivedScriptInfo(path) {
        if (isReady()) {
            $exports.triggerHandler("receivedScriptInfo", [path]);
        } else {
            _queuedScripts.push(path);
        }
    }

    function _sendQueuedEvents() {
        _queuedScripts.forEach(function (path) {
            $exports.triggerHandler("receivedScriptInfo", [path]);
        });
        _queuedScripts = [];
    }

    /**
     * Called when the browser loads new code and sends us a scripts-added event
     *
     * @param {array of functions} functions
     * @param {array of call sites} callSites
     */
    function _addNodes(nodes) {
        var indexByPath = function (obj, path, hash) {
            if (path in hash) {
                hash[path].push(obj);
            } else {
                hash[path] = [obj];
            }
        }

        for (var i in nodes) {
            var n = nodes[i];
            _nodes[n.id] = n;
            indexByPath(n, n.path, _nodesByFilePath);
        }
    }

    function _setInspectorCallbacks() {
        Inspector.Page.enable();
        $(DOMAgent).on("getDocument", _gotDocument);
        $(Inspector.DOM).on("attributeModified", _onAttributeModified);

        // AJAX testing

        // Inspector.Debugger.enable();
        // Inspector.Debugger.setBreakpointsActive(true);
        // Inspector.DOMDebugger.setXHRBreakpoint("");
        // $(Inspector.Debugger).on("paused", function (jqev, ev) {
        //     console.log("XHR breakpoint", ev.callFrames, ev.data, ev.data.url);
        //     Inspector.Runtime.getProperties(ev.callFrames[0].this.objectId, function () {
        //         console.log("got properties", arguments, arguments[0].result.map(function (o) { return o.name }));
        //         Inspector.Debugger.resume();
        //     });
        // });
        // Inspector.Network.enable();
        // $(Inspector.Network).on("responseReceived", function () {
        //     console.log("Network responseReceived", arguments);
        // });
    }

    function _clearInspectorCallbacks() {
        $(DOMAgent).off("getDocument", _gotDocument);
        $(Inspector.DOM).off("attributeModified", _onAttributeModified);
    }

    function _resetAll() {
        _proxyURL = undefined;
        _resetConnection();
    }

    function _resetConnection() {
        _tracerObjectId = undefined;
        _defaultTrackingHandle = undefined;
        _queuedScripts = [];
        _nodes = {};
        _nodesByFilePath = {};
        _invocations = {};
        _nodeHitCounts = {};
    }

    /**
     * functionName is the name of the property of the tracer to invoke
     * args is an array of arguments fit for passing to Inspector.Runtime.callFunctionOn
     * callback will be called with either the result value, or no arguments if there was an error
     * TODO: the first argument to the callback should be err, dude
     */
    function _invoke(functionName, args, callback) {
        Inspector.Runtime.callFunctionOn(_tracerObjectId, "tracer." + functionName, args, true, true, function (res) {
            if (!res.wasThrown) {
                callback && callback(res.result.value);
            } else {
                console.log('Inspector.Runtime.callFunctionOn exception', res);
                callback && callback();
            }
        });
    }

    /**
     * like $.grep, but iterates over the values in an object instead of a
     * collection
     */
    function _objectValueGrep(obj, filter) {
        var results = [];
        for (var i in obj) {
            if (filter(obj[i], i)) {
                results.push(obj[i]);
            }
        }
        return results;
    }

    function functionWithId(fid) {
        return _nodes[fid];
    }

    function functionsInFile(path) {
        return (_nodesByFilePath[path] || []).filter(function (n) { return n.type === "function" });
    }

    /**
     * returns all functions in the file at the given path containing the given
     * line/column, in order of appearance in the file (so the last one will
     * be the inner-most function)
     * TODO: document whether line and column are 0-indexed
     */
    var functionsContaining = function (path, line, column) {
        var funcs = _objectValueGrep(functionsInFile(path), Util.containsFilter(path, line, column));
        funcs.sort(Util.startPositionComparator);
        return funcs;
    };

    function cachedHitCounts() {
        return _nodeHitCounts;
    }

    function trackHits(callback) {
        _invoke("trackHits", [], callback);
    }

    /**
     * callback will get 2 arguments: hitCounts, and deltas
     * both of the form { functions: {fid -> count}, callSites: {fid -> count} }
     * (they point to internal storage, so please don't modify)
     */
    function refreshHitCounts(callback) {
        _invoke("hitCountDeltas", [{ value: _defaultTrackingHandle }], function (deltas) {
            if (deltas) {
                for (var id in deltas) {
                    _nodeHitCounts[id] = (_nodeHitCounts[id] || 0) + deltas[id];
                }
                callback(_nodeHitCounts, deltas);
            } else {
                callback();
            }
        });
    }

    function trackLogs(query, callback) {
        _invoke("trackLogs", [{ value: query }], callback);
    }

    function refreshLogs(handle, maxResults, callback) {
        _invoke("logDelta", [{ value: handle }, { value: maxResults }], callback);
    }

    function backtrace(options, callback) {
        _invoke("backtrace", [{ value: options }], callback);
    }

    function isReady() {
        return fsm.state === "connected";
    }

    function init() {
        Inspector.on("connect", function () {
            _setInspectorCallbacks();
            fsm.trigger("inspectorConnected");
        });
        Inspector.on("disconnect", function () {
            _clearInspectorCallbacks();
            fsm.trigger("inspectorDisconnected");
        });
    }

    // exports
    exports.init = init;
    exports.isReady = isReady;

    // satisfied from locally cached data
    // (read-only once received from browser)
    exports.functionWithId = functionWithId;
    exports.functionsInFile = functionsInFile;
    exports.functionsContaining = functionsContaining;

    // fetch data from the browser
    exports.trackHits = trackHits;
    exports.refreshHitCounts = refreshHitCounts;
    exports.cachedHitCounts = cachedHitCounts;
    exports.trackLogs = trackLogs;
    exports.refreshLogs = refreshLogs;
    exports.backtrace = backtrace;
});