/**
 * history.js
 * Transaction history: local cache, fetch + annotate, render.
 *
 * Depends on globals from index.html:
 *   globalData, getText, escHtml, amountFormat,
 *   getConfig, getBackend, blockExplorer, $
 *
 * Public API:
 *   loadHistory()            → annotated tx array from localStorage
 *   saveHistory(txs)         → persist to localStorage
 *   annotateTx(meta, detail) → classify tx direction/amount
 *   updateHistory()          → fetch + render (async)
 *   renderHistory(txs, total)→ paint #history-list
 */

var HISTORY_LIMIT = 10

// ---------------------------------------------------------------------------
// localStorage cache  (per-address key, never mixes wallets)
// ---------------------------------------------------------------------------

function loadHistory() {
    var key = 'bte_history_' + globalData.address
    try { return JSON.parse(localStorage.getItem(key) || '[]') } catch (e) { return [] }
}

function saveHistory(txs) {
    if (!globalData.address) return
    try { localStorage.setItem('bte_history_' + globalData.address, JSON.stringify(txs)) } catch (e) {}
}

// ---------------------------------------------------------------------------
// annotateTx — classify direction and net amount for one transaction
//
// REST API contract (from /tx/<txid>):
//   txDetail.vin[]  — each input may have:
//     .txinwitness[]        P2WPKH witness: [<sig_hex>, <pubkey_hex>]
//     .scriptSig.hex        Legacy P2PKH: <sig_push> <pubkey_push>
//   txDetail.vout[] — each output has:
//     .value_sat  (int, added by server)   ← preferred, avoids float math
//     .value      (float BTE, fallback)
//     .scriptPubKey.hex / .address / .addresses[]
//
// Detection logic:
//   weAreSender  → our pubkey appears in any input witness or scriptSig
//   isOurs(vout) → output scriptPubKey matches our script hex or address
//
//   direction:
//     'in'   — we did not send; amount = sum of outputs to us
//     'out'  — we sent to at least one external output; amount = sum sent out
//     'self' — we sent but ALL outputs came back to us (consolidation / self-transfer);
//              amount = sum of outputs received (= sent − fee)
// ---------------------------------------------------------------------------

function annotateTx(txMeta, txDetail) {
    var vin   = txDetail.vin  || []
    var vout  = txDetail.vout || []
    var myPub = (globalData.pubKeyHex || '').toLowerCase()

    // ── Sender detection ────────────────────────────────────────────────────
    var weAreSender = vin.some(function(input) {
        // P2WPKH native segwit — witness stack: [sig, pubkey]
        var wit = input.txinwitness || []
        if (wit[1] && wit[1].toLowerCase() === myPub) return true

        // Legacy P2PKH — scriptSig ends with OP_DATA(33) + compressed_pubkey
        // hex: last 68 chars = "21" + 66-char pubkey hex
        var sig = (input.scriptSig && input.scriptSig.hex)
            ? input.scriptSig.hex.toLowerCase() : ''
        if (sig.length >= 68 && sig.slice(-68) === '21' + myPub) return true

        return false
    })

    // ── Output classification ────────────────────────────────────────────────
    var received = 0, sentToOthers = 0

    vout.forEach(function(o) {
        var sat = (o.value_sat != null)
            ? o.value_sat
            : Math.round((o.value || 0) * 1e8)

        var hex = (o.scriptPubKey && o.scriptPubKey.hex)
            ? o.scriptPubKey.hex.toLowerCase() : ''

        // Primary: match by scriptPubKey hex (most reliable)
        var isOurs = hex
            ? (globalData.allScriptHexes
                ? globalData.allScriptHexes.has(hex)
                : hex === (globalData.scriptHex || '').toLowerCase())
            : false

        // Fallback: match by address string (covers exotic/OP_RETURN edge cases)
        if (!isOurs && o.scriptPubKey) {
            var outAddr = o.scriptPubKey.address
                || (o.scriptPubKey.addresses && o.scriptPubKey.addresses[0])
                || ''
            if (outAddr) {
                isOurs = globalData.allAddresses
                    ? globalData.allAddresses.has(outAddr)
                    : outAddr === (globalData.address || '')
            }
        }

        if (isOurs) {
            received += sat
        } else {
            sentToOthers += sat
        }
    })

    // ── Direction + net amount ───────────────────────────────────────────────
    var direction, amount
    if (weAreSender) {
        var isSelfSend = (sentToOthers === 0)
        direction = isSelfSend ? 'self' : 'out'
        amount    = isSelfSend ? received : sentToOthers
    } else {
        direction = 'in'
        amount    = received
    }

    return {
        tx_hash:   txMeta.tx_hash,
        height:    txMeta.height,
        direction: direction,
        amount:    amount
    }
}

// ---------------------------------------------------------------------------
// updateHistory — fetch /history then /tx for each recent entry
//
// FIX 1: data.error != null  (loose, catches both null and undefined)
//         The strict  !== null  would treat a proxy-stripped JSON (no error
//         field → undefined) as an error response.
//
// FIX 2: capture requestedAddress before the async chain and verify it
//         matches globalData.address when results arrive — prevents a
//         logout+quick-login race from rendering the previous wallet's history.
// ---------------------------------------------------------------------------

function updateHistory() {
    if (globalData.status !== 'unlocked') return

    // Capture address at request time (FIX 2)
    var requestedAddress = globalData.address

    $('#history-list').html(
        '<div class="text-muted text-center py-3 small">' +
        escHtml(getText('history-loading')) + '</div>'
    )

    fetch(getBackend() + '/history/' + requestedAddress)
    .then(function(r) { return r.json() })
    .then(function(data) {
        // FIX 1: loose != catches both null and undefined
        if (!data || data.error != null) {
            $('#history-list').html(
                '<div class="text-danger text-center py-3 small">' +
                escHtml(getText('history-failed')) + '</div>'
            )
            return
        }

        var all    = data.result || []
        var total  = all.length
        // ElectrumX returns history oldest-first → take last N → reverse for newest-first
        var recent = all.slice(-HISTORY_LIMIT).reverse()

        if (recent.length === 0) { renderHistory([], total); return }

        var fetches = recent.map(function(txMeta) {
            return fetch(getBackend() + '/tx/' + txMeta.tx_hash)
            .then(function(r) { return r.json() })
            .then(function(d) {
                var txDetail = (d.error == null && d.result) ? d.result : {}
                return annotateTx(txMeta, txDetail)
            })
            .catch(function() {
                return { tx_hash: txMeta.tx_hash, height: txMeta.height, direction: 'unknown', amount: null }
            })
        })

        Promise.all(fetches).then(function(annotated) {
            // FIX 2: discard if wallet changed during fetch
            if (!globalData.address || globalData.address !== requestedAddress) return
            saveHistory(annotated)
            renderHistory(annotated, total)
        })
    })
    .catch(function() {
        $('#history-list').html(
            '<div class="text-danger text-center py-3 small">' +
            escHtml(getText('history-network-error')) + '</div>'
        )
    })
}

// ---------------------------------------------------------------------------
// renderHistory — paint #history-list DOM
// ---------------------------------------------------------------------------

function renderHistory(txs, total) {
    if (!txs || txs.length === 0) {
        $('#history-list').html(
            '<div class="text-muted text-center py-3 small">' +
            escHtml(getText('no-transactions')) + '</div>'
        )
        return
    }

    var html   = ''
    var ticker = getConfig()['ticker']

    txs.forEach(function(tx) {
        var confirmed = tx.height !== 0
        var confs = confirmed
            ? (globalData.height > 0
                ? (globalData.height - tx.height + 1) + ' ' + getText('history-conf')
                : getText('history-confirmed'))
            : getText('history-pending')

        var confBadge = confirmed
            ? '<span class="badge text-bg-success ms-1">' + escHtml(confs) + '</span>'
            : '<span class="badge text-bg-warning ms-1">' + escHtml(getText('history-pending')) + '</span>'

        var dir = tx.direction || 'unknown'
        var amt = (tx.amount != null) ? amountFormat(tx.amount) : '?'

        var dirLabel
        if (dir === 'in') {
            dirLabel = '<span class="font-weight-bold text-success" style="min-width:110px;display:inline-block">&#x2193; +' + escHtml(String(amt)) + ' ' + escHtml(ticker) + '</span>'
        } else if (dir === 'out') {
            dirLabel = '<span class="font-weight-bold text-danger"  style="min-width:110px;display:inline-block">&#x2191; -' + escHtml(String(amt)) + ' ' + escHtml(ticker) + '</span>'
        } else if (dir === 'self') {
            dirLabel = '<span class="font-weight-bold text-info"    style="min-width:110px;display:inline-block">&#x21C5; '  + escHtml(String(amt)) + ' ' + escHtml(ticker) + '</span>'
        } else {
            dirLabel = '<span class="text-muted"                    style="min-width:110px;display:inline-block">— ? '       + escHtml(ticker) + '</span>'
        }

        var safeHash  = escHtml(tx.tx_hash || '')
        var txUrl     = escHtml(blockExplorer.tx(tx.tx_hash || ''))
        var shortHash = safeHash.substr(0, 10) + '…' + safeHash.substr(-6)

        html += '<div class="history-item d-flex align-items-center border-bottom" style="gap:6px">' +
            dirLabel +
            '<div class="font-monospace text-truncate flex-grow-1" style="font-size:11px">' +
                '<a href="' + txUrl + '" target="_blank" rel="noopener noreferrer">' + shortHash + '</a>' +
            '</div>' +
            '<div class="flex-shrink-0">' + confBadge + '</div>' +
        '</div>'
    })

    if (total && total > HISTORY_LIMIT) {
        var explorerUrl = escHtml(blockExplorer.address(globalData.address))
        html += '<div class="text-center py-2"><small>' +
            '<a href="' + explorerUrl + '" target="_blank" rel="noopener noreferrer">' +
            escHtml(getText('history-view-all')) + ' ' + total + ' ' +
            escHtml(getText('history-on-explorer')) + ' &#x2197;' +
            '</a></small></div>'
    }

    $('#history-list').html(html)
}
