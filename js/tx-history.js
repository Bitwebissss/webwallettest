(function () {
    'use strict';

    var _globalData    = null;
    var _escHtml       = null;
    var _getText       = null;
    var _getBackend    = null;
    var _getConfig     = null;
    var _amountFormat  = null;
    var _blockExplorer = null;

    var HISTORY_LIMIT = 10;

    function init(deps) {
        _globalData    = deps.globalData;
        _escHtml       = deps.escHtml;
        _getText       = deps.getText;
        _getBackend    = deps.getBackend;
        _getConfig     = deps.getConfig;
        _amountFormat  = deps.amountFormat;
        _blockExplorer = deps.blockExplorer;
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

    function updateHistory() {
        if (_globalData.status !== 'unlocked') return;

        var requestedAddress = _globalData.address;

        $('#history-list').html(
            '<div class="text-muted text-center py-3 small">' +
            _escHtml(_getText('history-loading')) + '</div>'
        );

        var url = _getBackend() + '/history/' + requestedAddress
                + '?limit=' + HISTORY_LIMIT;

        fetch(url)
            .then(function (r) { return r.json(); })
            .then(function (data) {
                if (_globalData.address !== requestedAddress) return;

                if (data.error != null) {
                    $('#history-list').html(
                        '<div class="text-danger text-center py-3 small">' +
                        _escHtml(_getText('history-failed')) + '</div>'
                    );
                    return;
                }

                var txs = data.result || [];
                saveHistory(txs);
                renderHistory(txs);
            })
            .catch(function () {
                var cached = loadHistory();
                if (cached.length) {
                    renderHistory(cached);
                } else {
                    $('#history-list').html(
                        '<div class="text-danger text-center py-3 small">' +
                        _escHtml(_getText('history-network-error')) + '</div>'
                    );
                }
            });
    }

    function _formatTs(ts) {
        if (!ts) return '';
        var d   = new Date(ts * 1000);
        var pad = function (n) { return n < 10 ? '0' + n : String(n); };
        return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + '.' +
               d.getFullYear() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    }

    function renderHistory(txs) {
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

            var confBadge = confirmed
                ? '<span class="badge text-bg-success ms-1">' +
                  _escHtml(
                      _globalData.height > 0
                          ? (_globalData.height - tx.height + 1) + ' ' + _getText('history-conf')
                          : _getText('history-confirmed')
                  ) + '</span>'
                : '<span class="badge text-bg-warning ms-1">' +
                  _escHtml(_getText('history-pending')) + '</span>';

            var dir = tx.direction || 'unknown';
            var amt = (tx.amount != null) ? _amountFormat(tx.amount) : '?';

            var dirLabel;
            if (dir === 'in') {
                dirLabel = '<span class="fw-bold text-success tx-dir-label">' +
                           '&#x2193; +' + _escHtml(String(amt)) + ' ' + _escHtml(ticker) +
                           '</span>';
            } else if (dir === 'out') {
                dirLabel = '<span class="fw-bold text-danger tx-dir-label">' +
                           '&#x2191; &minus;' + _escHtml(String(amt)) + ' ' + _escHtml(ticker) +
                           '</span>';
            } else if (dir === 'self') {
                dirLabel = '<span class="fw-bold text-info tx-dir-label">' +
                           '&#x21C5; ' + _escHtml(String(amt)) + ' ' + _escHtml(ticker) +
                           '</span>';
            } else {
                dirLabel = '<span class="text-muted tx-dir-label">— ? ' +
                           _escHtml(ticker) + '</span>';
            }

            var safeHash  = _escHtml(tx.txid || '');
            var txUrl     = _escHtml(_blockExplorer.tx(tx.txid || ''));
            var shortHash = safeHash.substr(0, 10) + '\u2026' + safeHash.substr(-6);
            var tsHtml    = tx.timestamp
                ? '<div class="text-muted history-ts">' +
                  _escHtml(_formatTs(tx.timestamp)) + '</div>'
                : '';

            html += '<div class="history-item d-flex align-items-center border-bottom history-item-inner">' +
                    dirLabel +
                    '<div class="font-monospace text-truncate flex-grow-1 history-tx-hash">' +
                        '<a href="' + txUrl + '" target="_blank" rel="noopener noreferrer">' +
                        shortHash + '</a>' +
                        tsHtml +
                    '</div>' +
                    '<div class="flex-shrink-0">' + confBadge + '</div>' +
                    '</div>';
        });

        if (txs.length >= HISTORY_LIMIT) {
            var explorerUrl = _escHtml(_blockExplorer.address(_globalData.address));
            html += '<div class="text-center py-2"><small>' +
                    '<a href="' + explorerUrl + '" target="_blank" rel="noopener noreferrer">' +
                    _escHtml(_getText('history-view-all')) + ' &#x2197;' +
                    '</a></small></div>';
        }

        $('#history-list').html(html);
    }
    window.TxHistory = {
        init:          init,
        loadHistory:   loadHistory,
        saveHistory:   saveHistory,
        updateHistory: updateHistory,
        renderHistory: renderHistory
    };
})();
