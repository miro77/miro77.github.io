/* P.528 Explorer: parameter sliders and a live curve. */
(function () {
    'use strict';

    var SVG_NS = 'http://www.w3.org/2000/svg';

    var MODES = {
        1: { key: 'los', name: 'Line of sight' },
        2: { key: 'diffraction', name: 'Diffraction' },
        3: { key: 'troposcatter', name: 'Troposcatter' }
    };

    // Slider definitions. Logarithmic sliders cover several decades evenly.
    var PARAMS = [
        { id: 'f', label: 'Frequency', unit: 'MHz', min: 100, max: 30000, log: true, def: 1200 },
        { id: 'h1', label: 'Low terminal height', unit: 'm', min: 1.5, max: 20000, log: true, def: 10 },
        { id: 'h2', label: 'High terminal height', unit: 'm', min: 1.5, max: 20000, log: true, def: 10000 },
        { id: 'p', label: 'Time percentage', unit: '%', min: 1, max: 99, step: 1, def: 50 },
        { id: 'erp', label: 'Radiated power (e.r.p.)', unit: 'kW', min: 0.001, max: 1000, log: true, def: 1 },
        { id: 'dmax', label: 'Distance range', unit: 'km', min: 50, max: 1800, step: 50, def: 1000 },
        { id: 'n', label: 'Number of points', unit: '', min: 11, max: 5000, log: true, integer: true, def: 401 }
    ];
    var PARAM_BY_ID = {};
    PARAMS.forEach(function (param) { PARAM_BY_ID[param.id] = param; });

    var ERROR_TEXT = {
        1: 'The distance must not be negative.',
        2: 'The low terminal height is outside 1.5 m to 80 km.',
        3: 'The high terminal height is outside 1.5 m to 80 km.',
        4: 'The low terminal must not be higher than the high terminal.',
        5: 'The frequency must be at least 100 MHz.',
        6: 'The frequency must be at most 30 000 MHz.',
        7: 'The time percentage must be at least 1 %.',
        8: 'The time percentage must be at most 99 %.',
        9: 'Unknown polarization.'
    };

    var state = { pol: 0, quantity: 'e' };
    PARAMS.forEach(function (param) { state[param.id] = param.def; });

    var controls = {};        // id -> { range, number, root }
    var data = null;          // last result of the model
    var hoverIndex = -1;      // index of the point under the crosshair
    var layout = null;        // geometry of the last render

    var chart = document.getElementById('chart');
    var chartWrap = document.getElementById('chart-wrap');
    var tooltip = document.getElementById('tooltip');
    var message = document.getElementById('chart-message');

    // ---------------------------------------------------------------- helpers

    function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }

    function round3(value) { return Number(value.toPrecision(3)); }

    function fmt(value, digits) {
        return value.toLocaleString('en-US', {
            minimumFractionDigits: digits, maximumFractionDigits: digits
        });
    }

    function fmtParam(value) {
        return value.toLocaleString('en-US', { maximumSignificantDigits: 4 });
    }

    function el(name, attrs, text) {
        var node = document.createElementNS(SVG_NS, name);
        for (var key in attrs) node.setAttribute(key, attrs[key]);
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function html(name, className, text) {
        var node = document.createElement(name);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function posToValue(param, pos) {
        var t = pos / 1000;
        if (param.log) {
            var scaled = round3(param.min * Math.pow(param.max / param.min, t));
            return clamp(param.integer ? Math.round(scaled) : scaled, param.min, param.max);
        }
        var value = param.min + t * (param.max - param.min);
        return clamp(Math.round(value / param.step) * param.step, param.min, param.max);
    }

    function valueToPos(param, value) {
        var t = param.log
            ? Math.log(value / param.min) / Math.log(param.max / param.min)
            : (value - param.min) / (param.max - param.min);
        return Math.round(clamp(t, 0, 1) * 1000);
    }

    /** Field strength in dB(uV/m) from the basic transmission loss. */
    function fieldStrength(loss__db, f__mhz, erp__kw) {
        return 139.3 + 20 * Math.log10(f__mhz) - loss__db + 10 * Math.log10(erp__kw);
    }

    // ------------------------------------------------------------- URL state

    function readHash() {
        var query = new URLSearchParams(location.hash.replace(/^#/, ''));
        PARAMS.forEach(function (param) {
            var value = parseFloat(query.get(param.id));
            if (isFinite(value))
                state[param.id] = clamp(param.integer ? Math.round(value) : value, param.min, param.max);
        });
        if (query.get('pol') === '1') state.pol = 1;
        if (query.get('q') === 'l') state.quantity = 'l';
        if (state.h1 > state.h2) state.h2 = state.h1;
    }

    var hashTimer = 0;
    function writeHash() {
        clearTimeout(hashTimer);
        hashTimer = setTimeout(function () {
            var parts = PARAMS.map(function (param) { return param.id + '=' + state[param.id]; });
            parts.push('pol=' + state.pol, 'q=' + state.quantity);
            try { history.replaceState(null, '', '#' + parts.join('&')); } catch (e) { /* ignore */ }
        }, 250);
    }

    // --------------------------------------------------------------- controls

    function buildControls() {
        var host = document.getElementById('sliders');
        PARAMS.forEach(function (param) {
            var root = html('div', 'control');
            var head = html('div', 'control-head');
            var label = html('label', 'control-label', param.label);
            label.htmlFor = 'range-' + param.id;

            var valueBox = html('span', 'control-value');
            var number = html('input');
            number.type = 'number';
            number.min = param.min;
            number.max = param.max;
            number.step = 'any';
            number.setAttribute('aria-label', param.unit ? param.label + ' in ' + param.unit : param.label);
            valueBox.appendChild(number);
            valueBox.appendChild(html('span', 'control-unit', param.unit));

            head.appendChild(label);
            head.appendChild(valueBox);

            var range = html('input');
            range.type = 'range';
            range.id = 'range-' + param.id;
            range.min = 0;
            range.max = 1000;
            range.step = 1;

            var scale = html('div', 'control-scale');
            scale.appendChild(html('span', '', fmtParam(param.min)));
            scale.appendChild(html('span', '', fmtParam(param.max)));

            root.appendChild(head);
            root.appendChild(range);
            root.appendChild(scale);
            host.appendChild(root);
            controls[param.id] = { root: root, range: range, number: number };

            range.addEventListener('input', function () {
                setParam(param.id, posToValue(param, Number(range.value)));
            });
            number.addEventListener('change', function () {
                var value = parseFloat(number.value);
                if (param.integer) value = Math.round(value);
                setParam(param.id, isFinite(value) ? clamp(value, param.min, param.max) : state[param.id]);
            });
        });

        document.querySelectorAll('input[name="pol"]').forEach(function (radio) {
            radio.addEventListener('change', function () {
                state.pol = Number(radio.value);
                writeHash();
                requestCurve();
            });
        });
        document.querySelectorAll('input[name="quantity"]').forEach(function (radio) {
            radio.addEventListener('change', function () {
                state.quantity = radio.value;
                syncControls();
                writeHash();
                render();
            });
        });
        document.getElementById('reset').addEventListener('click', function () {
            PARAMS.forEach(function (param) { state[param.id] = param.def; });
            state.pol = 0;
            syncControls();
            writeHash();
            requestCurve();
        });
    }

    function setParam(id, value) {
        state[id] = value;
        // the model requires h1 <= h2, so the other terminal follows
        if (id === 'h1' && state.h1 > state.h2) state.h2 = state.h1;
        if (id === 'h2' && state.h2 < state.h1) state.h1 = state.h2;
        syncControls();
        writeHash();
        // the radiated power only shifts the curve, no need to run the model
        if (id === 'erp') render(); else requestCurve();
    }

    function syncControls() {
        PARAMS.forEach(function (param) {
            var control = controls[param.id];
            var pos = valueToPos(param, state[param.id]);
            control.range.value = pos;
            control.range.style.setProperty('--pos', (pos / 10) + '%');
            control.range.setAttribute('aria-valuetext', (fmtParam(state[param.id]) + ' ' + param.unit).trim());
            if (document.activeElement !== control.number) control.number.value = state[param.id];
        });
        // the radiated power has no effect on the transmission loss
        var erp = controls.erp;
        var lossView = state.quantity === 'l';
        erp.root.dataset.disabled = lossView;
        erp.range.disabled = lossView;
        erp.number.disabled = lossView;

        document.querySelectorAll('input[name="pol"]').forEach(function (radio) {
            radio.checked = Number(radio.value) === state.pol;
        });
        document.querySelectorAll('input[name="quantity"]').forEach(function (radio) {
            radio.checked = radio.value === state.quantity;
        });
    }

    // ------------------------------------------------------------ the model

    var worker = null;
    var workerReady = false;
    var busy = false;
    var queued = false;
    var requestId = 0;
    var pendingRequest = null;
    var staleTimer = 0;

    function startWorker() {
        try {
            worker = new Worker('assets/p528-worker.js');
        } catch (error) {
            showMessage('This browser cannot start the calculation worker.');
            return;
        }
        worker.onmessage = function (event) {
            var reply = event.data;
            if (reply.type === 'ready') {
                workerReady = true;
                requestCurve();
            } else if (reply.type === 'result') {
                busy = false;
                clearTimeout(staleTimer);
                chart.classList.remove('stale');
                if (pendingRequest && reply.id === pendingRequest.id) takeResult(reply, pendingRequest);
                if (queued) requestCurve();
            } else if (reply.type === 'failed') {
                busy = false;
                showMessage('The model could not be loaded: ' + reply.message);
            }
        };
        worker.onerror = function () {
            showMessage('The model could not be loaded.');
        };
    }

    /** Asks for a new curve. While one is being computed only the most recent
     *  request is kept, so the curve follows the slider without a backlog. */
    function requestCurve() {
        if (!workerReady || busy) {
            queued = true;
            return;
        }
        queued = false;
        busy = true;
        pendingRequest = {
            id: ++requestId, points: state.n,
            f: state.f, h1: state.h1, h2: state.h2, p: state.p, pol: state.pol, dmax: state.dmax
        };
        worker.postMessage(pendingRequest);
        // keep the previous curve, dimmed, if the answer takes noticeably long
        clearTimeout(staleTimer);
        staleTimer = setTimeout(function () { chart.classList.add('stale'); }, 200);
    }

    function takeResult(reply, request) {
        var n = request.points;
        var v = reply.values;
        var result = {
            request: request, ms: reply.ms, warnings: reply.warnings, returnCode: reply.returnCode,
            d: new Float64Array(n), loss: new Float64Array(n), freeSpace: new Float64Array(n),
            absorption: new Float64Array(n), mode: new Uint8Array(n)
        };
        for (var i = 0; i < n; i++) {
            result.d[i] = v[5 * i];
            result.loss[i] = v[5 * i + 1];
            result.freeSpace[i] = v[5 * i + 2];
            result.absorption[i] = v[5 * i + 3];
            result.mode[i] = v[5 * i + 4];
        }
        data = result;
        render();
    }

    function showMessage(text) {
        message.textContent = text;
        message.hidden = false;
    }

    // -------------------------------------------------------------- rendering

    function niceStep(span, maxTicks, candidates) {
        for (var i = 0; i < candidates.length; i++)
            if (span / candidates[i] <= maxTicks) return candidates[i];
        return candidates[candidates.length - 1];
    }

    function render() {
        if (!data) return;

        var n = data.d.length;
        var fieldView = state.quantity === 'e';
        var f = data.request.f;
        var toY = fieldView
            ? function (loss) { return fieldStrength(loss, f, state.erp); }
            : function (loss) { return loss; };

        var yMain = new Float64Array(n);
        var yFree = new Float64Array(n);
        var valid = new Uint8Array(n);
        var any = false;
        for (var i = 0; i < n; i++) {
            yMain[i] = toY(data.loss[i]);
            yFree[i] = toY(data.freeSpace[i]);
            valid[i] = data.mode[i] !== 0 && isFinite(yMain[i]) && isFinite(yFree[i]) ? 1 : 0;
            if (valid[i]) any = true;
        }

        updateTexts(fieldView, yMain, valid);
        if (!any) {
            chart.textContent = '';
            layout = null;
            var code = data.returnCode;
            showMessage(ERROR_TEXT[code] || 'No result for these parameters.');
            return;
        }
        message.hidden = true;

        // ---- geometry
        var width = Math.max(280, Math.round(chartWrap.clientWidth));
        var height = Math.round(chart.getBoundingClientRect().height) || 440;
        chart.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
        var left = 52, right = 24, top = 30, bottom = 44;
        var plotW = width - left - right;
        var plotH = height - top - bottom;

        // The value at zero distance can be far above the rest of the curve. The
        // axis range is taken from the points after it, the curve is clipped.
        var lo = Infinity, hi = -Infinity;
        for (i = 1; i < n; i++) {
            if (!valid[i]) continue;
            lo = Math.min(lo, yMain[i], yFree[i]);
            hi = Math.max(hi, yMain[i], yFree[i]);
        }
        if (!isFinite(lo)) { lo = yMain[0] - 10; hi = yMain[0] + 10; }
        var yStep = niceStep(hi - lo, Math.max(3, Math.floor(plotH / 44)), [5, 10, 20, 25, 50, 100, 200]);
        var yLo = Math.floor(lo / yStep) * yStep;
        var yHi = Math.ceil(hi / yStep) * yStep;
        if (yHi === yLo) yHi = yLo + yStep;

        var dmax = data.request.dmax;
        var xOf = function (d) { return left + d / dmax * plotW; };
        // a stronger signal is always up: the loss axis is inverted
        var yOf = fieldView
            ? function (y) { return top + (yHi - y) / (yHi - yLo) * plotH; }
            : function (y) { return top + (y - yLo) / (yHi - yLo) * plotH; };

        var nodes = document.createDocumentFragment();
        var defs = el('defs', {});
        var clip = el('clipPath', { id: 'plot-clip' });
        clip.appendChild(el('rect', { x: left, y: top - 2, width: plotW, height: plotH + 4 }));
        defs.appendChild(clip);
        nodes.appendChild(defs);

        // ---- grid, ticks and axis titles
        for (var y = yLo; y <= yHi + 1e-9; y += yStep) {
            var py = Math.round(yOf(y)) + 0.5;
            nodes.appendChild(el('line', { 'class': 'grid', x1: left, x2: left + plotW, y1: py, y2: py }));
            nodes.appendChild(el('text', { x: left - 8, y: py + 4, 'text-anchor': 'end' }, fmt(y, 0)));
        }
        var xStep = niceStep(dmax, Math.max(3, Math.floor(plotW / 56)), [10, 20, 25, 50, 100, 200, 250, 500, 1000]);
        for (var x = 0; x <= dmax + 1e-9; x += xStep) {
            var px = Math.round(xOf(x)) + 0.5;
            nodes.appendChild(el('line', { 'class': 'grid', x1: px, x2: px, y1: top, y2: top + plotH }));
            nodes.appendChild(el('text', { x: px, y: top + plotH + 18, 'text-anchor': 'middle' }, fmt(x, 0)));
        }
        var baseline = Math.round(top + plotH) + 0.5;
        nodes.appendChild(el('line', { 'class': 'axis-line', x1: left, x2: left + plotW, y1: baseline, y2: baseline }));
        nodes.appendChild(el('text', {
            'class': 'axis-title', x: left + plotW / 2, y: height - 6, 'text-anchor': 'middle'
        }, 'Distance (km)'));
        nodes.appendChild(el('text', {
            'class': 'axis-title', x: 0, y: 12
        }, fieldView ? 'dB(µV/m)' : 'dB, axis inverted'));

        // ---- runs of equal propagation mode
        var runs = [];
        for (i = 0; i < n; i++) {
            if (!valid[i]) continue;
            var last = runs[runs.length - 1];
            if (last && last.mode === data.mode[i] && last.end === i - 1) last.end = i;
            else runs.push({ mode: data.mode[i], start: i, end: i });
        }

        // mode names above the plot, with hairlines where the mode changes
        runs.forEach(function (run, r) {
            var next = runs[r + 1];
            var x0 = xOf(data.d[run.start]);
            var x1 = next ? xOf(data.d[next.start]) : left + plotW;
            if (next) {
                var bx = Math.round(x1) + 0.5;
                nodes.appendChild(el('line', { 'class': 'band-edge', x1: bx, x2: bx, y1: top - 8, y2: top + plotH }));
            }
            var name = MODES[run.mode] ? MODES[run.mode].name : '';
            if (x1 - x0 > name.length * 6.6 + 12)
                nodes.appendChild(el('text', {
                    'class': 'band-label', x: (x0 + x1) / 2, y: top - 10, 'text-anchor': 'middle'
                }, name));
        });

        // ---- curves
        var plot = el('g', { 'clip-path': 'url(#plot-clip)' });
        var path = '';
        for (i = 0; i < n; i++) {
            if (!valid[i]) continue;
            path += (path ? 'L' : 'M') + xOf(data.d[i]).toFixed(1) + ' ' + yOf(yFree[i]).toFixed(1);
        }
        plot.appendChild(el('path', { 'class': 'series series-free-space', d: path }));

        runs.forEach(function (run, r) {
            var next = runs[r + 1];
            // extend each run to the first point of the next one, so the curve has no gaps
            var end = next && next.start === run.end + 1 ? next.start : run.end;
            var segment = '';
            for (var k = run.start; k <= end; k++)
                segment += (segment ? 'L' : 'M') + xOf(data.d[k]).toFixed(1) + ' ' + yOf(yMain[k]).toFixed(1);
            if (run.start === end) segment += 'L' + xOf(data.d[end]).toFixed(1) + ' ' + yOf(yMain[end]).toFixed(1);
            plot.appendChild(el('path', {
                'class': 'series series-' + (MODES[run.mode] ? MODES[run.mode].key : 'los'), d: segment
            }));
        });
        nodes.appendChild(plot);

        // ---- hover layer
        var hover = el('g', { id: 'hover', visibility: 'hidden' });
        hover.appendChild(el('line', { 'class': 'crosshair', id: 'crosshair', y1: top, y2: top + plotH }));
        hover.appendChild(el('circle', { 'class': 'dot dot-free-space', id: 'dot-free', r: 4 }));
        hover.appendChild(el('circle', { 'class': 'dot', id: 'dot-main', r: 5 }));
        nodes.appendChild(hover);

        chart.textContent = '';
        chart.appendChild(nodes);

        layout = {
            left: left, top: top, plotW: plotW, plotH: plotH, width: width,
            xOf: xOf, yOf: yOf, yMain: yMain, yFree: yFree, valid: valid, fieldView: fieldView
        };
        if (hoverIndex >= 0) showHover(hoverIndex);
        updateTable();
    }

    function unitOf(fieldView) { return fieldView ? 'dBµV/m' : 'dB'; }

    function updateTexts(fieldView, yMain, valid) {
        var request = data.request;
        document.getElementById('chart-title').textContent =
            fieldView ? 'Field strength over distance' : 'Basic transmission loss over distance';

        var parts = [
            fmtParam(request.f) + ' MHz',
            'terminals at ' + fmtParam(request.h1) + ' m and ' + fmtParam(request.h2) + ' m',
            fmtParam(request.p) + ' % of time',
            request.pol === 1 ? 'vertical polarization' : 'horizontal polarization'
        ];
        if (fieldView) parts.push(fmtParam(state.erp) + ' kW e.r.p.');
        document.getElementById('chart-subtitle').textContent = parts.join(' · ');

        // radio horizon: where the path leaves line of sight
        var n = data.d.length;
        var horizon = -1;
        for (var i = 0; i < n; i++)
            if (valid[i] && data.mode[i] !== 1) { horizon = i; break; }
        setStat('stat-horizon',
            horizon >= 0 ? fmt(data.d[horizon], 0) : '> ' + fmt(request.dmax, 0), 'km');

        var last = n - 1;
        while (last > 0 && !valid[last]) last--;
        document.getElementById('stat-end-label').textContent = 'At ' + fmt(request.dmax, 0) + ' km';
        setStat('stat-end', valid[last] ? fmt(yMain[last], 1) : '–', unitOf(fieldView));
        setStat('stat-time', data.ms < 10 ? fmt(data.ms, 1) : fmt(data.ms, 0), 'ms for ' + n + ' points');

        var notes = [];
        if (data.warnings & 1)
            notes.push('The diffraction and troposcatter models may not be physically consistent for these parameters.');
        if (data.warnings & 6)
            notes.push('A terminal is above the height limit of the Recommendation; treat the result as informative.');
        var notice = document.getElementById('notice');
        notice.textContent = notes.join(' ');
        notice.hidden = notes.length === 0;
    }

    function setStat(id, value, unit) {
        var node = document.getElementById(id);
        node.textContent = value + ' ';
        node.appendChild(html('small', '', unit));
    }

    // ------------------------------------------------------------ hover layer

    function showHover(index) {
        if (!layout || !data) return;
        var n = data.d.length;
        index = clamp(index, 0, n - 1);
        // step to the nearest point that has a result
        var probe = index;
        while (probe < n - 1 && !layout.valid[probe]) probe++;
        while (probe > 0 && !layout.valid[probe]) probe--;
        if (!layout.valid[probe]) return;
        hoverIndex = index = probe;

        var x = layout.xOf(data.d[index]);
        var yLimit = function (y) { return clamp(y, layout.top, layout.top + layout.plotH); };
        var hover = chart.querySelector('#hover');
        var line = chart.querySelector('#crosshair');
        var dotMain = chart.querySelector('#dot-main');
        var dotFree = chart.querySelector('#dot-free');
        var mode = MODES[data.mode[index]] || MODES[1];

        line.setAttribute('x1', x);
        line.setAttribute('x2', x);
        dotMain.setAttribute('cx', x);
        dotMain.setAttribute('cy', yLimit(layout.yOf(layout.yMain[index])));
        dotMain.setAttribute('class', 'dot dot-' + mode.key);
        dotFree.setAttribute('cx', x);
        dotFree.setAttribute('cy', yLimit(layout.yOf(layout.yFree[index])));
        hover.setAttribute('visibility', 'visible');

        // tooltip: values lead, names follow
        var unit = unitOf(layout.fieldView);
        tooltip.textContent = '';
        tooltip.appendChild(html('div', 'tooltip-title', fmt(data.d[index], data.request.dmax < 200 ? 1 : 0) + ' km'));
        tooltip.appendChild(tooltipRow('key-' + mode.key, fmt(layout.yMain[index], 1) + ' ' + unit, mode.name));
        tooltip.appendChild(tooltipRow('key-free-space', fmt(layout.yFree[index], 1) + ' ' + unit, 'Free space'));
        var extra = html('div', 'tooltip-extra');
        extra.appendChild(html('div', '', layout.fieldView
            ? 'Transmission loss ' + fmt(data.loss[index], 1) + ' dB'
            : 'Free space loss ' + fmt(data.freeSpace[index], 1) + ' dB'));
        extra.appendChild(html('div', '', 'Atmospheric absorption ' + fmt(data.absorption[index], 2) + ' dB'));
        tooltip.appendChild(extra);
        tooltip.hidden = false;

        var scale = chartWrap.clientWidth / layout.width;
        var tipWidth = tooltip.offsetWidth;
        var tipX = x * scale + 14;
        if (tipX + tipWidth > chartWrap.clientWidth) tipX = x * scale - 14 - tipWidth;
        tooltip.style.transform = 'translate(' + Math.max(0, tipX) + 'px,' + (layout.top + 8) + 'px)';
    }

    function tooltipRow(keyClass, value, name) {
        var row = html('div', 'tooltip-row');
        row.appendChild(html('span', 'line-key ' + keyClass));
        row.appendChild(html('strong', '', value));
        row.appendChild(html('span', 'name', name));
        return row;
    }

    function hideHover() {
        hoverIndex = -1;
        tooltip.hidden = true;
        var hover = chart.querySelector('#hover');
        if (hover) hover.setAttribute('visibility', 'hidden');
    }

    function indexAt(clientX) {
        var rect = chart.getBoundingClientRect();
        var x = (clientX - rect.left) / rect.width * layout.width;
        var t = (x - layout.left) / layout.plotW;
        return Math.round(clamp(t, 0, 1) * (data.d.length - 1));
    }

    function bindHover() {
        chart.addEventListener('pointermove', function (event) {
            if (layout) showHover(indexAt(event.clientX));
        });
        chart.addEventListener('pointerdown', function (event) {
            if (layout) showHover(indexAt(event.clientX));
        });
        chart.addEventListener('pointerleave', function (event) {
            if (event.pointerType !== 'touch' && document.activeElement !== chart) hideHover();
        });
        chart.addEventListener('focus', function () {
            if (layout && hoverIndex < 0) showHover(Math.floor(data.d.length / 2));
        });
        chart.addEventListener('blur', hideHover);
        chart.addEventListener('keydown', function (event) {
            if (!layout) return;
            var step = event.shiftKey ? 10 : 1;
            var index = hoverIndex < 0 ? Math.floor(data.d.length / 2) : hoverIndex;
            if (event.key === 'ArrowLeft') index -= step;
            else if (event.key === 'ArrowRight') index += step;
            else if (event.key === 'Home') index = 0;
            else if (event.key === 'End') index = data.d.length - 1;
            else if (event.key === 'Escape') { hideHover(); return; }
            else return;
            event.preventDefault();
            showHover(index);
        });
    }

    // ------------------------------------------------------------- table view

    function rowValues(i) {
        var mode = MODES[data.mode[i]];
        return [
            fmt(data.d[i], 1),
            fmt(fieldStrength(data.loss[i], data.request.f, state.erp), 1),
            fmt(data.loss[i], 1),
            fmt(data.freeSpace[i], 1),
            fmt(data.absorption[i], 2),
            mode ? mode.name : 'No result'
        ];
    }

    function updateTable() {
        var details = document.querySelector('.table-view');
        if (!details.open || !data) return;
        var body = document.querySelector('#data-table tbody');
        var rows = document.createDocumentFragment();
        var n = data.d.length;
        var stride = Math.max(1, Math.ceil((n - 1) / 40));
        for (var i = 0; i < n; i += stride) {
            var tr = document.createElement('tr');
            rowValues(i).forEach(function (text) { tr.appendChild(html('td', '', text)); });
            rows.appendChild(tr);
        }
        body.textContent = '';
        body.appendChild(rows);
    }

    function downloadCsv() {
        if (!data) return;
        var lines = ['distance_km,field_strength_dbuv_m,transmission_loss_db,free_space_loss_db,absorption_db,mode'];
        for (var i = 0; i < data.d.length; i++) {
            var mode = MODES[data.mode[i]];
            lines.push([
                data.d[i].toFixed(3),
                fieldStrength(data.loss[i], data.request.f, state.erp).toFixed(3),
                data.loss[i].toFixed(3), data.freeSpace[i].toFixed(3), data.absorption[i].toFixed(4),
                mode ? mode.name : ''
            ].join(','));
        }
        var link = document.createElement('a');
        link.href = URL.createObjectURL(new Blob([lines.join('\n') + '\n'], { type: 'text/csv' }));
        link.download = 'p528-curve.csv';
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(function () { URL.revokeObjectURL(link.href); }, 1000);
    }

    // ------------------------------------------------------------------ theme

    function currentTheme() {
        var stored = document.documentElement.dataset.theme;
        if (stored === 'light' || stored === 'dark') return stored;
        return window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }

    function bindTheme() {
        var label = document.getElementById('theme-toggle-label');
        var update = function () { label.textContent = currentTheme() === 'dark' ? 'Light' : 'Dark'; };
        document.getElementById('theme-toggle').addEventListener('click', function () {
            var next = currentTheme() === 'dark' ? 'light' : 'dark';
            document.documentElement.dataset.theme = next;
            try { localStorage.setItem('theme', next); } catch (e) { /* not stored */ }
            update();
        });
        update();
    }

    // ------------------------------------------------------------------ start

    readHash();
    buildControls();
    syncControls();
    bindHover();
    bindTheme();
    document.getElementById('download-csv').addEventListener('click', downloadCsv);
    document.querySelector('.table-view').addEventListener('toggle', updateTable);
    window.addEventListener('hashchange', function () {
        readHash();
        syncControls();
        requestCurve();
    });
    if (window.ResizeObserver) new ResizeObserver(function () { render(); }).observe(chartWrap);
    else window.addEventListener('resize', render);
    startWorker();
})();
