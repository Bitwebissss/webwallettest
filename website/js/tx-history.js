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
            /* copy-link handler — delegated, set once */
            $(document).off('click.hcopy').on('click.hcopy', '.h-copy-btn', function () {
                const url  = $(this).data('copy-url');
                const $btn = $(this);
                if (!url) return;
                const done = () => {
                    $btn.addClass('btn-success').removeClass('btn-outline-secondary').text('✓');
                    setTimeout(() => $btn.removeClass('btn-success').addClass('btn-outline-secondary').text('⧉'), 1500);
                };
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(url).then(done).catch(() => {
                        /* fallback for http or blocked clipboard */
                        try { const ta = document.createElement('textarea');
                              ta.value = url; ta.style.cssText = 'position:fixed;opacity:0';
                              document.body.appendChild(ta); ta.select();
                              document.execCommand('copy'); document.body.removeChild(ta); done();
                        } catch (_) {}
                    });
                } else {
                    try { const ta = document.createElement('textarea');
                          ta.value = url; ta.style.cssText = 'position:fixed;opacity:0';
                          document.body.appendChild(ta); ta.select();
                          document.execCommand('copy'); document.body.removeChild(ta); done();
                    } catch (_) {}
                }
            });
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
            const url = this.#getBackend() + '/history/' + encodeURIComponent(requestedAddress)
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
                const txs = Array.isArray(data.result) ? data.result : [];
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
        /* first8…last8 truncation for narrow screens */
        #truncHash(hash) {
            if (!hash || hash.length <= 20) return hash;
            return hash.slice(0, 8) + '\u2026' + hash.slice(-8);
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
            let html     = '';
            const ticker = this.#getConfig()['ticker'];
            const chainHeight = Number(this.#globalData.height);
            txs.forEach(tx => {
                const h = Number(tx.height);
                const confirmed = h > 0;
                const confBadge = confirmed
                    ? '<span class="badge text-bg-success ms-1">' +
                      (chainHeight > 0
                          ? this.#escHtml(String(Math.max(0, chainHeight - h + 1))) +
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
                const safeHashFull  = this.#escHtml(tx.txid || '');
                const safeHashShort = this.#escHtml(this.#truncHash(tx.txid || ''));
                const rawTxUrl  = this.#blockExplorer.tx(tx.txid || '');
                const txUrl     = this.#escHtml(rawTxUrl);
                const tsHtml    = tx.timestamp
                    ? '<span class="history-ts">' + this.#escHtml(this.#formatTs(tx.timestamp)) + '</span>'
                    : '<span class="history-ts"></span>';

                /*
                 * 5 direct grid children → columns line up perfectly:
                 *   [dirLabel] [hash] [date] [copy] [badge]
                 */
                html +=
                    '<div class="history-item border-bottom">' +
                    /* col 1 — amount */
                    dirLabel +
                    /* col 2 — hash (full on wide, short on narrow via CSS) */
                    '<div class="font-monospace history-tx-hash">' +
                        '<a href="' + txUrl + '" target="_blank" rel="noopener noreferrer">' +
                            '<span class="hash-full">'  + safeHashFull  + '</span>' +
                            '<span class="hash-short">' + safeHashShort + '</span>' +
                        '</a>' +
                    '</div>' +
                    /* col 3 — date */
                    tsHtml +
                    /* col 4 — copy link button */
                    '<button class="btn btn-sm btn-outline-secondary h-copy-btn" data-copy-url="' + txUrl + '" title="Copy explorer link">&#x29C7;</button>' +
                    /* col 5 — confirmations */
                    '<div class="h-badge">' + confBadge + '</div>' +
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
