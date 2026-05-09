(function () {
    'use strict';
    var _globalData   = null;
    var _escHtml      = null;
    var _getText      = null;
    var _getBackend   = null;
    var _getConfig    = null;
    var _amountFormat = null;
    var _blockExplorer = null;
    var HISTORY_LIMIT = 10;

    // In-memory cache for previous-output transactions.
    // Cleared on each updateHistory() call. Avoids fetching the same tx
    // multiple times when several history entries share common inputs.
    var _prevTxCache = Object.create(null);

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

    // -----------------------------------------------------------------------
    // isOurOutput
    // Returns true if a vout (from a verbose transaction) belongs to one of
    // our addresses. Checks by scriptPubKey.hex first — the most reliable and
    // type-agnostic method (works for P2PKH, P2SH, P2WPKH, P2TR and any other
    // script type). Falls back to address comparison when hex is absent.
    // -----------------------------------------------------------------------
    function isOurOutput(o) {
        if (!o || !o.scriptPubKey) return false;

        var hex = o.scriptPubKey.hex
            ? o.scriptPubKey.hex.toLowerCase()
            : '';

        if (hex) {
            return _globalData.allScriptHexes
                ? _globalData.allScriptHexes.has(hex)
                : hex === (_globalData.scriptHex || '').toLowerCase();
        }

        // Fallback: check by address (older ElectrumX versions may omit hex)
        var addr = o.scriptPubKey.address
            || (o.scriptPubKey.addresses && o.scriptPubKey.addresses[0])
            || '';
        if (addr) {
            return _globalData.allAddresses
                ? _globalData.allAddresses.has(addr)
                : addr === (_globalData.address || '');
        }

        return false;
    }

    // -----------------------------------------------------------------------
    // fetchTxCached
    // Fetches a verbose transaction by txid, using _prevTxCache to avoid
    // duplicate network requests within a single history refresh.
    // -----------------------------------------------------------------------
    function fetchTxCached(txid) {
        if (_prevTxCache[txid]) return Promise.resolve(_prevTxCache[txid]);
        return fetch(_getBackend() + '/tx/' + txid)
            .then(function (r) { return r.json(); })
            .then(function (d) {
                var tx = (d.error == null && d.result) ? d.result : {};
                _prevTxCache[txid] = tx;
                return tx;
            });
    }

    // -----------------------------------------------------------------------
    // annotateTx — returns a Promise
    //
    // How direction is determined:
    //
    //   weAreSender = any input whose previous output pays to one of our
    //                 scriptpubkeys.
    //
    // This is the ONLY correct universal approach. Checking for our pubkey
    // inside txinwitness / scriptSig fails for:
    //   - Taproot key-path spending: witness = [<64-byte Schnorr sig>], no pubkey
    //   - Taproot script-path spending: witness = [stack…, script, control-block]
    //   - P2SH-wrapped segwit with non-standard scriptSig encoding
    //
    // After we know weAreSender we compute:
    //   received      = sum of vout amounts that pay to us
    //   sentToOthers  = sum of vout amounts that pay to others
    //
    //   weAreSender && sentToOthers == 0  → 'self'  (consolidation / internal move)
    //   weAreSender && sentToOthers  > 0  → 'out',  amount = sentToOthers
    //   !weAreSender                      → 'in',   amount = received
    // -----------------------------------------------------------------------
    function annotateTx(txMeta, txDetail) {
        var vin  = txDetail.vin  || [];
        var vout = txDetail.vout || [];

        // --- vout pass ---
        var received = 0, sentToOthers = 0;
        vout.forEach(function (o) {
            var sat = (o.value_sat != null)
                ? o.value_sat
                : Math.round((o.value || 0) * 1e8);
            if (isOurOutput(o)) {
                received += sat;
            } else {
                sentToOthers += sat;
            }
        });

        // --- vin pass: resolve previous outputs to detect sender ---
        // Coinbase inputs have no txid — skip them (they can never be ours).
        var inputChecks = vin.map(function (input) {
            if (!input.txid) return Promise.resolve(false);
            return fetchTxCached(input.txid)
                .then(function (prevTx) {
                    var prevOut = (prevTx.vout || [])[input.vout];
                    return !!prevOut && isOurOutput(prevOut);
                })
                .catch(function () { return false; });
        });

        return Promise.all(inputChecks).then(function (results) {
            var weAreSender = results.some(Boolean);

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
        });
    }

    function updateHistory() {
        if (_globalData.status !== 'unlocked') return;
        var requestedAddress = _globalData.address;

        // Clear the cache on every refresh so stale data never bleeds through.
        _prevTxCache = Object.create(null);

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
                            // Seed the cache: this tx may be referenced as a
                            // previous output by another tx in the same batch.
                            _prevTxCache[txMeta.tx_hash] = txDetail;
                            return annotateTx(txMeta, txDetail);
                        })
                        .catch(function () {
                            return {
                                tx_hash:   txMeta.tx_hash,
                                height:    txMeta.height,
                                direction: 'unknown',
                                amount:    null
                            };
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

    window.TxHistory = {
        init:          init,
        loadHistory:   loadHistory,
        saveHistory:   saveHistory,
        updateHistory: updateHistory,
        renderHistory: renderHistory
    };
})();
