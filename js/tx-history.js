(function () {
    'use strict';

    /**
     * Transaction history module.
     *
     * Must be initialised once via TxHistory.init(deps) before any wallet
     * interaction.  All dependencies are injected so this file stays
     * independent of wallet.js internals.
     *
     * Exported API (window.TxHistory):
     *   init(deps)                  — inject dependencies (called once from wallet.js)
     *   loadHistory()               — load cached history from localStorage
     *   saveHistory(txs)            — persist history to localStorage
     *   updateHistory()             — fetch + annotate + render history from backend
     *   renderHistory(txs, total)   — render pre-built tx array into the DOM
     */

    /* ── Dependencies (injected via init) ──────────────────────────────── */
    var _globalData  = null;   // wallet.js globalData object (passed by reference)
    var _escHtml     = null;   // escHtml(str) → safe HTML string
    var _getText     = null;   // getText(token) → translated string
    var _getBackend  = null;   // getBackend() → API base URL string
    var _getConfig   = null;   // getConfig() → network config object
    var _amountFormat = null;  // amountFormat(sats) → display string
    var _blockExplorer = null; // { address(addr), tx(txid) } → explorer URLs

    var HISTORY_LIMIT = 10;

    /**
     * Inject all required dependencies from wallet.js.
     *
     * @param {{
     *   globalData:    object,
     *   escHtml:       Function,
     *   getText:       Function,
     *   getBackend:    Function,
     *   getConfig:     Function,
     *   amountFormat:  Function,
     *   blockExplorer: { address: Function, tx: Function }
     * }} deps
     */
    function init(deps) {
        _globalData    = deps.globalData;
        _escHtml       = deps.escHtml;
        _getText       = deps.getText;
        _getBackend    = deps.getBackend;
        _getConfig     = deps.getConfig;
        _amountFormat  = deps.amountFormat;
        _blockExplorer = deps.blockExplorer;
    }

    /* ── Storage helpers ────────────────────────────────────────────────── */

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

    /* ── Transaction annotation ─────────────────────────────────────────── */

    /**
     * Determine direction (in / out / self) and net amount for one transaction
     * by inspecting its inputs and outputs against our known script hashes /
     * addresses.
     */
    function annotateTx(txMeta, txDetail) {
        var vin   = txDetail.vin  || [];
        var vout  = txDetail.vout || [];
        var myPub = (_globalData.pubKeyHex || '').toLowerCase();

        var weAreSender = vin.some(function (input) {
            var wit = input.txinwitness || [];
            if (wit[1] && wit[1].toLowerCase() === myPub) return true;
            var sig = (input.scriptSig && input.scriptSig.hex)
                ? input.scriptSig.hex.toLowerCase() : '';
            if (sig.length >= 68 && sig.slice(-68) === '21' + myPub) return true;
            return false;
        });

        var received = 0, sentToOthers = 0;
        vout.forEach(function (o) {
            var sat = (o.value_sat != null)
                ? o.value_sat
                : Math.round((o.value || 0) * 1e8);
            var hex = (o.scriptPubKey && o.scriptPubKey.hex)
                ? o.scriptPubKey.hex.toLowerCase() : '';
            var isOurs = hex
                ? (_globalData.allScriptHexes
                    ? _globalData.allScriptHexes.has(hex)
                    : hex === (_globalData.scriptHex || '').toLowerCase())
                : false;

            if (!isOurs && o.scriptPubKey) {
                var outAddr = o.scriptPubKey.address
                    || (o.scriptPubKey.addresses && o.scriptPubKey.addresses[0])
                    || '';
                if (outAddr) {
                    isOurs = _globalData.allAddresses
                        ? _globalData.allAddresses.has(outAddr)
                        : outAddr === (_globalData.address || '');
                }
            }

            if (isOurs) {
                received += sat;
            } else {
                sentToOthers += sat;
            }
        });

        var direction, amount;
        if (weAreSender) {
            var isSelfSend = (sentToOthers === 0);
            direction = isSelfSend ? 'self' : 'out';
            amount    = isSelfSend ? received : sentToOthers;
        } else {
            direction = 'in';
            amount    = received;
        }

        return {
            tx_hash:   txMeta.tx_hash,
            height:    txMeta.height,
            direction: direction,
            amount:    amount
        };
    }

    /* ── Fetch + render ─────────────────────────────────────────────────── */

    /** Fetch address history from the backend, annotate each tx, then render. */
    function updateHistory() {
        if (_globalData.status !== 'unlocked') return;
        var requestedAddress = _globalData.address;

        $('#history-list').html(
            '<div class="text-muted text-center py-3 small">' +
            _escHtml(_getText('history-loading')) + '</div>'
        );

        fetch(_getBackend() + '/history/' + requestedAddress)
            .then(function (r) { return r.json(); })
            .then(function (data) {
                if (!data || data.error != null) {
                    $('#history-list').html(
                        '<div class="text-danger text-center py-3 small">' +
                        _escHtml(_getText('history-failed')) + '</div>'
                    );
                    return;
                }

                var all    = data.result || [];
                var total  = all.length;
                var recent = all.slice(-HISTORY_LIMIT).reverse();
                if (recent.length === 0) { renderHistory([], total); return; }

                var fetches = recent.map(function (txMeta) {
                    return fetch(_getBackend() + '/tx/' + txMeta.tx_hash)
                        .then(function (r) { return r.json(); })
                        .then(function (d) {
                            var txDetail = (d.error == null && d.result) ? d.result : {};
                            return annotateTx(txMeta, txDetail);
                        })
                        .catch(function () {
                            return { tx_hash: txMeta.tx_hash, height: txMeta.height, direction: 'unknown', amount: null };
                        });
                });

                Promise.all(fetches).then(function (annotated) {
                    if (!_globalData.address || _globalData.address !== requestedAddress) return;
                    saveHistory(annotated);
                    renderHistory(annotated, total);
                });
            })
            .catch(function () {
                $('#history-list').html(
                    '<div class="text-danger text-center py-3 small">' +
                    _escHtml(_getText('history-network-error')) + '</div>'
                );
            });
    }

    /** Render a pre-built array of annotated transactions into #history-list. */
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
                dirLabel = '<span class="font-weight-bold text-info tx-dir-label">&#x21C5; '  + _escHtml(String(amt)) + ' ' + _escHtml(ticker) + '</span>';
            } else {
                dirLabel = '<span class="text-muted tx-dir-label">— ? ' + _escHtml(ticker) + '</span>';
            }

            var safeHash  = _escHtml(tx.tx_hash || '');
            var txUrl     = _escHtml(_blockExplorer.tx(tx.tx_hash || ''));
            var shortHash = safeHash.substr(0, 10) + '…' + safeHash.substr(-6);

            html += '<div class="history-item d-flex align-items-center border-bottom history-item-inner">' +
                dirLabel +
                '<div class="font-monospace text-truncate flex-grow-1 history-tx-hash">' +
                    '<a href="' + txUrl + '" target="_blank" rel="noopener noreferrer">' + shortHash + '</a>' +
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

    /* ── Public API ─────────────────────────────────────────────────────── */

    window.TxHistory = {
        init:          init,
        loadHistory:   loadHistory,
        saveHistory:   saveHistory,
        updateHistory: updateHistory,
        renderHistory: renderHistory
    };

})();
