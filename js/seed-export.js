/**
 * seed-export.js
 * Generates a seed-phrase backup image (PNG) and triggers a download.
 * Works on desktop (Windows/Mac/Linux) and Android.
 * iOS Safari fallback: opens PNG in a new tab → long-press → Save to Photos.
 *
 * Usage (called from index.html):
 *   seedExportPNG(mnemonic, getText)
 *
 * @param {string}   mnemonic  — space-separated seed words
 * @param {function} getText   — i18n lookup: getText('seed-print-secret') etc.
 */
function seedExportPNG(mnemonic, getText) {
    if (!mnemonic) return

    var words = mnemonic.split(' ')
    var cols  = 4
    var rows  = Math.ceil(words.length / cols)

    // ── Canvas dimensions ────────────────────────────────────────────────────
    var W       = 800
    var padX    = 44
    var padY    = 36
    var headerH = 72      // red warning bar
    var warnH   = 46      // "Keep Secret" sub-line
    var cellW   = Math.floor((W - padX * 2) / cols)
    var cellH   = 40
    var gridH   = rows * cellH
    var pathH   = 36
    var footerH = 38
    var H       = padY + headerH + warnH + 16 + gridH + 16 + pathH + footerH + padY

    var canvas = document.createElement('canvas')
    var dpr    = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width  = W * dpr
    canvas.height = H * dpr
    var ctx = canvas.getContext('2d')
    ctx.scale(dpr, dpr)

    // ── Background ───────────────────────────────────────────────────────────
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, W, H)

    // ── Red header bar ───────────────────────────────────────────────────────
    ctx.fillStyle    = '#c0392b'
    ctx.fillRect(0, padY, W, headerH)
    ctx.fillStyle    = '#ffffff'
    ctx.font         = 'bold 22px system-ui, sans-serif'
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(getText('seed-print-secret'), W / 2, padY + headerH / 2)

    // ── Warning sub-line ─────────────────────────────────────────────────────
    ctx.fillStyle = '#7b1a12'
    ctx.fillRect(0, padY + headerH, W, warnH)
    ctx.fillStyle = '#fff3f3'
    ctx.font      = '13px system-ui, sans-serif'
    ctx.fillText('⚠  Never share this image. Store it offline only.', W / 2, padY + headerH + warnH / 2)

    // ── Word grid ────────────────────────────────────────────────────────────
    var gridTop = padY + headerH + warnH + 16
    ctx.textBaseline = 'middle'
    words.forEach(function(word, i) {
        var col = i % cols
        var row = Math.floor(i / cols)
        var x   = padX + col * cellW
        var y   = gridTop + row * cellH
        var cx  = x + cellW / 2
        var cy  = y + cellH / 2

        // alternating cell background
        ctx.fillStyle = (row + col) % 2 === 0 ? '#f7f8fa' : '#eef0f4'
        if (ctx.roundRect) {
            ctx.beginPath(); ctx.roundRect(x + 2, y + 2, cellW - 4, cellH - 4, 6); ctx.fill()
        } else {
            ctx.fillRect(x + 2, y + 2, cellW - 4, cellH - 4)
        }

        // cell border
        ctx.strokeStyle = '#d0d4dc'
        ctx.lineWidth   = 1
        if (ctx.roundRect) {
            ctx.beginPath(); ctx.roundRect(x + 2, y + 2, cellW - 4, cellH - 4, 6); ctx.stroke()
        } else {
            ctx.strokeRect(x + 2, y + 2, cellW - 4, cellH - 4)
        }

        // index number
        ctx.fillStyle = '#9ca3af'
        ctx.font      = '11px system-ui, sans-serif'
        ctx.textAlign = 'left'
        ctx.fillText(i + 1, x + 10, cy)

        // word
        ctx.fillStyle = '#1a1a2e'
        ctx.font      = 'bold 15px system-ui, monospace'
        ctx.textAlign = 'center'
        ctx.fillText(word, cx + 8, cy)
    })

    // ── Derivation path ──────────────────────────────────────────────────────
    var pathY = gridTop + gridH + 16
    ctx.fillStyle    = '#f0f2f5'
    ctx.fillRect(padX, pathY, W - padX * 2, pathH)
    ctx.fillStyle    = '#374151'
    ctx.font         = '12px system-ui, monospace'
    ctx.textAlign    = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText(getText('seed-path-label') + "  m/84'/0'/0'/0/0  (BIP84 native SegWit)", padX + 12, pathY + pathH / 2)

    // ── Footer: date ─────────────────────────────────────────────────────────
    var footerY = pathY + pathH
    var now     = new Date()
    var dateStr = now.getFullYear() + '-' +
                  String(now.getMonth() + 1).padStart(2, '0') + '-' +
                  String(now.getDate()).padStart(2, '0')
    ctx.fillStyle    = '#9ca3af'
    ctx.font         = '11px system-ui, sans-serif'
    ctx.textAlign    = 'right'
    ctx.textBaseline = 'middle'
    ctx.fillText('Generated ' + dateStr, W - padX, footerY + footerH / 2)

    // ── Download ─────────────────────────────────────────────────────────────
    try {
        var link      = document.createElement('a')
        link.href     = canvas.toDataURL('image/png')
        link.download = 'seed-backup-' + dateStr + '.png'
        document.body.appendChild(link)
        link.click()
        document.body.removeChild(link)
    } catch (e) {
        // iOS Safari: open in new tab → long-press → Save to Photos
        window.open(canvas.toDataURL('image/png'), '_blank')
    }
}
