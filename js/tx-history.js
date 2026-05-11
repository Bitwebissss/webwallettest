(function () {
    'use strict';
    const HISTORY_LIMIT = 10;
    class TxHistoryManager {
        #globalData    = null;
        #escHtml       = null;
        #getText       = null;
        #getBackend    = null;
        #getConfig     = null;
        #amountFormat  = null;
        #blockExplorer = null;
        init(deps) {
            this.#globalData    = deps.globalData;
            this.#escHtml       = deps.escHtml;
            this.#getText       = deps.getText;
            this.#getBackend    = deps.getBackend;
            this.#getConfig     = deps.getConfig;
            this.#amountFormat  = deps.amountFormat;
            this.#blockExplorer = deps.blockExplorer;
        }
        loadHistory() {
            const key = 'bte_history_' + this.#globalData.address;
            try { return JSON.parse(localStorage.getItem(key) || '[]'); } catch (e) { return []; }
        }
        saveHistory(txs) {
            if (!this.#globalData.address) return;
            try {
                localStorage.setItem('bte_history_' + this.#globalData.address, JSON.stringify(txs));
            } catch (e) {}
        }
        async updateHistory() {
            if (this.#globalData.status !== 'unlocked') return;
            const requestedAddress = this.#globalData.address;
            $('#history-list').html(
                '<div class="text-muted text-center py-3 small">' +
                this.#escHtml(this.#getText('history-loading')) + '</div>'
            );
            const url = this.#getBackend() + '/history/' + requestedAddress
                      + '?limit=' + HISTORY_LIMIT;
            try {
                const r    = await fetch(url);
                const data = await r.json();
                if (this.#globalData.address !== requestedAddress) return;
                if (data.error != null) {
                    $('#history-list').html(
                        '<div class="text-danger text-center py-3 small">' +
                        this.#escHtml(this.#getText('history-failed')) + '</div>'
                    );
                    return;
                }
                const txs = data.result || [];
                this.saveHistory(txs);
                this.renderHistory(txs);
            } catch {
                const cached = this.loadHistory();
                if (cached.length) {
                    this.renderHistory(cached);
                } else {
                    $('#history-list').html(
                        '<div class="text-danger text-center py-3 small">' +
                        this.#escHtml(this.#getText('history-network-error')) + '</div>'
                    );
                }
            }
        }
        #formatTs(ts) {
            if (!ts) return '';
            const d   = new Date(ts * 1000);
            const pad = n => n < 10 ? '0' + n : String(n);
            return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + '.' +
                   d.getFullYear() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
        }
        renderHistory(txs) {
            if (!txs || txs.length === 0) {
                $('#history-list').html(
                    '<div class="text-muted text-center py-3 small">' +
                    this.#escHtml(this.#getText('no-transactions')) + '</div>'
                );
                return;
            }
            let html         = '';
            const ticker     = this.#getConfig()['ticker'];
            txs.forEach(tx => {
                const confirmed = tx.height !== 0;
                const confBadge = confirmed
                    ? '<span class="badge text-bg-success ms-1">' +
                      (this.#globalData.height > 0
                          ? this.#escHtml(String(this.#globalData.height - tx.height + 1)) +
                            ' <span tkey="history-conf">' + this.#escHtml(this.#getText('history-conf')) + '</span>'
                          : '<span tkey="history-confirmed">' + this.#escHtml(this.#getText('history-confirmed')) + '</span>'
                      ) + '</span>'
                    : '<span class="badge text-bg-warning ms-1"><span tkey="history-pending">' +
                      this.#escHtml(this.#getText('history-pending')) + '</span></span>';
                const dir = tx.direction || 'unknown';
                const amt = (tx.amount != null) ? this.#amountFormat(tx.amount) : '?';
                let dirLabel;
                if (dir === 'in') {
                    dirLabel = '<span class="fw-bold text-success tx-dir-label">' +
                               '&#x2193; +' + this.#escHtml(String(amt)) + ' ' + this.#escHtml(ticker) +
                               '</span>';
                } else if (dir === 'out') {
                    dirLabel = '<span class="fw-bold text-danger tx-dir-label">' +
                               '&#x2191; &minus;' + this.#escHtml(String(amt)) + ' ' + this.#escHtml(ticker) +
                               '</span>';
                } else if (dir === 'self') {
                    dirLabel = '<span class="fw-bold text-info tx-dir-label">' +
                               '&#x21C5; ' + this.#escHtml(String(amt)) + ' ' + this.#escHtml(ticker) +
                               '</span>';
                } else {
                    dirLabel = '<span class="text-muted tx-dir-label">— ? ' +
                               this.#escHtml(ticker) + '</span>';
                }
                const safeHash = this.#escHtml(tx.txid || '');
                const txUrl    = this.#escHtml(this.#blockExplorer.tx(tx.txid || ''));
                const tsHtml   = tx.timestamp
                    ? '<div class="text-muted history-ts">' +
                      this.#escHtml(this.#formatTs(tx.timestamp)) + '</div>'
                    : '';
                html += '<div class="history-item d-flex align-items-center border-bottom history-item-inner">' +
                        dirLabel +
                        '<div class="font-monospace flex-grow-1 history-tx-hash break-word">' +
                            '<a href="' + txUrl + '" target="_blank" rel="noopener noreferrer">' +
                            safeHash + '</a>' +
                            tsHtml +
                        '</div>' +
                        '<div class="flex-shrink-0">' + confBadge + '</div>' +
                        '</div>';
            });
            if (txs.length >= HISTORY_LIMIT) {
                const explorerUrl = this.#escHtml(this.#blockExplorer.address(this.#globalData.address));
                html += '<div class="text-center py-2"><small>' +
                        '<a href="' + explorerUrl + '" target="_blank" rel="noopener noreferrer">' +
                        this.#escHtml(this.#getText('history-view-all')) + ' &#x2197;' +
                        '</a></small></div>';
            }
            $('#history-list').html(html);
        }
    }
    window.TxHistory = new TxHistoryManager();
})();
