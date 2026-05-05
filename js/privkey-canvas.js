/**
 * privkey-canvas.js
 * Renders / masks / clears private key (WIF) on a <canvas> element.
 * The canvas is used instead of an <input> so the value is never in the DOM
 * as selectable text and won't be captured by autofill or screenshot OCR.
 *
 * Public API (called from index.html):
 *   _privkeyMask(canvasId)          — draw redacted dots
 *   _privkeyReveal(canvasId, wif)   — draw WIF string
 *   _privkeyClear(canvasId)         — wipe canvas memory
 */

function _canvasSetup(canvasId) {
    var canvas = document.getElementById(canvasId)
    if (!canvas) return null
    var dpr = window.devicePixelRatio || 1
    var lw  = canvas.parentElement ? canvas.parentElement.offsetWidth - 120 : 300
    if (lw < 100) lw = 300
    var lh = 38
    canvas.width  = Math.round(lw * dpr)
    canvas.height = Math.round(lh * dpr)
    canvas.style.width  = lw + 'px'
    canvas.style.height = lh + 'px'
    var ctx = canvas.getContext('2d')
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, lw, lh)
    return { ctx: ctx, w: lw, h: lh }
}

function _privkeyMask(canvasId) {
    var d = _canvasSetup(canvasId)
    if (!d) return
    var isDark = document.documentElement.getAttribute('data-bs-theme') === 'dark'
    d.ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.3)'
    d.ctx.lineWidth   = 2
    d.ctx.lineCap     = 'round'
    var y = d.h / 2, x = 8, len = 16, gap = 8
    var step  = len + gap
    var count = Math.floor((d.w - x * 2) / step)
    for (var i = 0; i < count; i++) {
        d.ctx.beginPath()
        d.ctx.moveTo(x + i * step, y)
        d.ctx.lineTo(x + i * step + len, y)
        d.ctx.stroke()
    }
}

function _privkeyReveal(canvasId, wif) {
    var d = _canvasSetup(canvasId)
    if (!d) return
    var isDark = document.documentElement.getAttribute('data-bs-theme') === 'dark'
    d.ctx.fillStyle    = isDark ? '#e9ecef' : '#212529'
    d.ctx.font         = '13px monospace'
    d.ctx.textBaseline = 'middle'
    d.ctx.fillText(wif, 6, d.h / 2)
}

function _privkeyClear(canvasId) {
    var canvas = document.getElementById(canvasId)
    if (!canvas) return
    var ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    canvas.width = 1   // release GPU texture memory
}
