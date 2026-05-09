(function () {
    'use strict';
    var _globalData   = null;
    var _escHtml      = null;
    var _getText      = null;
    var _getBackend   = null;
    var _getConfig    = null;
    var _amountFormat = null;
    var _blockExplorer = null;
    var HISTORY_LIMIT  = 10;
    var EXPLORER_BASE  = 'https://explorer.bitwebcore.net';
    var PENDING_TTL    = 86400000; // 24 h

    // Map<txid, {amount: sats, ts: ms}> — tx-ы отправленные нами, ещё в мемпуле
    var _pending = Object.create(null);

    function init(deps) {
        _globalData    = deps.globalData;
        _escHtml       = deps.escHtml;
        _getText       = deps.getText;
        _getBackend    = deps.getBackend;
        _getConfig     = deps.getConfig;
        _amountFormat  = deps.amountFormat;
        _blockExplorer = deps.blockExplorer;
    }

    // Вызывается из wallet.js сразу после успешного broadcast
    function addPending(txid, amount) {
        _pending[txid] = { amount: amount, ts: Date.now() };
    }

    function loadHistory() {
        var key = 'bte_history_' + _globalData.address;
        try { return JSON.parse(localStorage.getItem(key) || '[]'); } catch (e) { return []; }
    }

    function saveHistory(txs) {
        if (!_globalData.address) return;
        try {
            localStorage.setItem('bte_history_' + _globalData.address, JSON.stringify(txs));
        } catch (e) {}
    }

    // Определяем direction для mempool-транзакции без запросов к сети:
    //   1. txid в _pending          → мы отправили → 'out'
    //   2. height===0 UTXO с этим txid → нам пришло → 'in'
    function _annotateMempool(txHash) {
        if (_pending[txHash]) {
            return { direction: 'out', amount: _pending[txHash].amount };
        }
        var found = null;
        (_globalData.utxos || []).forEach(function (u) {
            if (u.txid === txHash && u.height === 0) found = u;
        });
        if (found) return { direction: 'in', amount: found.value };
        return { direction: 'unknown', amount: null };
    }

    function updateHistory() {
        if (_globalData.status !== 'unlocked') return;
        var requestedAddress = _globalData.address;

        // Чистим протухшие записи из _pending
        var now = Date.now();
        Object.keys(_pending).forEach(function (k) {
            if (now - _pending[k].ts > PENDING_TTL) delete _pending[k];
        });

        $('#history-list').html(
            '<div class="text-muted text-center py-3 small">' +
            _escHtml(_getText('history-loading')) + '</div>'
        );

        // Параллельно: наш бэк (heights + мемпул) и обозреватель (sent/received/timestamp)
        Promise.all([
            fetch(_getBackend() + '/history/' + requestedAddress)
                .then(function (r) { return r.json(); }),
            fetch(EXPLORER_BASE + '/ext/getaddresstxs/' + requestedAddress + '/0/' + HISTORY_LIMIT)
                .then(function (r) { return r.json(); })
                .catch(function () { return []; })
        ]).then(function (results) {
            var histData     = results[0];
            var explorerData = results[1];

            if (!histData || histData.error != null) {
                $('#history-list').html(
                    '<div class="text-danger text-center py-3 small">' +
                    _escHtml(_getText('history-failed')) + '</div>'
                );
                return;
            }
            if (_globalData.address !== requestedAddress) return;

            var all    = histData.result || [];
            var total  = all.length;
            var recent = all.slice(-HISTORY_LIMIT).reverse();
            if (recent.length === 0) { renderHistory([], total); return; }

            // explorerMap: txid → {sent, received, timestamp}
            var explorerMap = Object.create(null);
            if (Array.isArray(explorerData)) {
                explorerData.forEach(function (ex) {
                    if (ex.txid) explorerMap[ex.txid] = ex;
                });
            }

            // Explorer возвращает суммы в монетах (BTE), конвертируем в сатоши
            var factor = Math.pow(10, _getConfig()['decimals'] || 8);
            function coinsToSats(v) { return Math.round((v || 0) * factor); }

            var annotated = recent.map(function (item) {
                var ex = explorerMap[item.tx_hash];
                if (ex) {
                    var sentSats = coinsToSats(ex.sent);
                    var recvSats = coinsToSats(ex.received);
                    var dir, amt;
                    if (sentSats === 0) {
                        dir = 'in';
                        amt = recvSats;
                    } else {
                        var net = sentSats - recvSats;
                        if (net <= 0) { dir = 'self'; amt = recvSats; }
                        else          { dir = 'out';  amt = net; }
                    }
                    return { tx_hash: item.tx_hash, height: item.height, direction: dir, amount: amt, timestamp: ex.timestamp };
                }
                // Мемпул — аннотируем локально
                var mem = _annotateMempool(item.tx_hash);
                return { tx_hash: item.tx_hash, height: 0, direction: mem.direction, amount: mem.amount, timestamp: null };
            });

            // Tx подтвердился — убираем из _pending
            annotated.forEach(function (tx) {
                if (tx.height > 0 && _pending[tx.tx_hash]) delete _pending[tx.tx_hash];
            });

            saveHistory(annotated);
            renderHistory(annotated, total);
        }).catch(function () {
            $('#history-list').html(
                '<div class="text-danger text-center py-3 small">' +
                _escHtml(_getText('history-network-error')) + '</div>'
            );
        });
    }

    function _formatTs(ts) {
        if (!ts) return '';
        var d   = new Date(ts * 1000);
        var pad = function (n) { return n < 10 ? '0' + n : String(n); };
        return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + '.' + d.getFullYear() +
               ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    }

    function renderHistory(txs, total) {
        if (!txs || txs.length === 0) {
            $('#history-list').html(
                '<div class="text-muted text-center py-3 small">' +
                _escHtml(_getText('no-transactions')) + '</div>'
            );
            return;
        }
        var html   = '';
        var ticker = _getConfig()['ticker'];
        txs.forEach(function (tx) {
            var confirmed = tx.height !== 0;
            var confs = confirmed
                ? (_globalData.height > 0
                    ? (_globalData.height - tx.height + 1) + ' ' + _getText('history-conf')
                    : _getText('history-confirmed'))
                : _getText('history-pending');
            var confBadge = confirmed
                ? '<span class="badge text-bg-success ms-1">' + _escHtml(confs) + '</span>'
                : '<span class="badge text-bg-warning ms-1">' + _escHtml(_getText('history-pending')) + '</span>';

            var dir = tx.direction || 'unknown';
            var amt = (tx.amount != null) ? _amountFormat(tx.amount) : '?';
            var dirLabel;
            if (dir === 'in') {
                dirLabel = '<span class="font-weight-bold text-success tx-dir-label">&#x2193; +' + _escHtml(String(amt)) + ' ' + _escHtml(ticker) + '</span>';
            } else if (dir === 'out') {
                dirLabel = '<span class="font-weight-bold text-danger tx-dir-label">&#x2191; -' + _escHtml(String(amt)) + ' ' + _escHtml(ticker) + '</span>';
            } else if (dir === 'self') {
                dirLabel = '<span class="font-weight-bold text-info tx-dir-label">&#x21C5; ' + _escHtml(String(amt)) + ' ' + _escHtml(ticker) + '</span>';
            } else {
                dirLabel = '<span class="text-muted tx-dir-label">— ? ' + _escHtml(ticker) + '</span>';
            }

            var safeHash  = _escHtml(tx.tx_hash || '');
            var txUrl     = _escHtml(_blockExplorer.tx(tx.tx_hash || ''));
            var shortHash = safeHash.substr(0, 10) + '…' + safeHash.substr(-6);
            var tsHtml    = tx.timestamp
                ? '<div class="text-muted history-ts">' + _escHtml(_formatTs(tx.timestamp)) + '</div>'
                : '';

            html += '<div class="history-item d-flex align-items-center border-bottom history-item-inner">' +
                dirLabel +
                '<div class="font-monospace text-truncate flex-grow-1 history-tx-hash">' +
                    '<a href="' + txUrl + '" target="_blank" rel="noopener noreferrer">' + shortHash + '</a>' +
                    tsHtml +
                '</div>' +
                '<div class="flex-shrink-0">' + confBadge + '</div>' +
            '</div>';
        });

        if (total && total > HISTORY_LIMIT) {
            var explorerUrl = _escHtml(_blockExplorer.address(_globalData.address));
            html += '<div class="text-center py-2"><small>' +
                '<a href="' + explorerUrl + '" target="_blank" rel="noopener noreferrer">' +
                _escHtml(_getText('history-view-all')) + ' ' + total + ' ' +
                _escHtml(_getText('history-on-explorer')) + ' &#x2197;' +
                '</a></small></div>';
        }
        $('#history-list').html(html);
    }

    window.TxHistory = {
        init:          init,
        addPending:    addPending,
        loadHistory:   loadHistory,
        saveHistory:   saveHistory,
        updateHistory: updateHistory,
        renderHistory: renderHistory
    };
})();
