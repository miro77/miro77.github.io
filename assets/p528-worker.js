/* P.528 Explorer: runs the WebAssembly model off the main thread. */
importScripts('p528.js');

var VALUES_PER_POINT = 5;
var modulePromise = createP528({
    locateFile: function (file) { return file; }
});
var buffer = 0;
var bufferPoints = 0;

modulePromise.then(function () {
    postMessage({ type: 'ready' });
}).catch(function (error) {
    postMessage({ type: 'failed', message: String(error && error.message || error) });
});

onmessage = function (event) {
    var request = event.data;
    modulePromise.then(function (M) {
        var n = request.points;
        if (n > bufferPoints) {
            if (buffer) M._free(buffer);
            buffer = M._malloc(8 * VALUES_PER_POINT * n);
            bufferPoints = n;
        }

        var start = performance.now();
        var rc = M._p528_profile(0, request.dmax, n, request.h1, request.h2,
            request.f, request.pol, request.p, buffer);
        var ms = performance.now() - start;

        // copy out of the wasm heap, the heap view may change when it grows
        var values = new Float64Array(VALUES_PER_POINT * n);
        values.set(M.HEAPF64.subarray(buffer / 8, buffer / 8 + VALUES_PER_POINT * n));

        postMessage({
            type: 'result',
            id: request.id,
            returnCode: rc & 0xff,
            warnings: rc >> 8,
            ms: ms,
            values: values
        }, [values.buffer]);
    }).catch(function (error) {
        postMessage({ type: 'failed', message: String(error && error.message || error) });
    });
};
