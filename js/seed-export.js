(function () {
    'use strict';
    function seedExportPNG(mnemonic, getText) {
        if (!mnemonic) return;
        var words = mnemonic.split(' ');
        var cols  = 4;
        var rows  = Math.ceil(words.length / cols);
        var W       = 800;
        var padX    = 44;
        var padY    = 36;
        var headerH = 72;
        var warnH   = 46;
        var cellW   = Math.floor((W - padX * 2) / cols);
        var cellH   = 40;
        var gridH   = rows * cellH;
        var pathH   = 36;
        var footerH = 38;
        var H       = padY + headerH + warnH + 16 + gridH + 16 + pathH + footerH + padY;
        var canvas  = document.createElement('canvas');
        var dpr     = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width  = W * dpr;
        canvas.height = H * dpr;
        var ctx = canvas.getContext('2d');
        ctx.scale(dpr, dpr);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle    = '#c0392b';
        ctx.fillRect(0, padY, W, headerH);
        ctx.fillStyle    = '#ffffff';
        ctx.font         = 'bold 22px system-ui, sans-serif';
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(getText('seed-print-secret'), W / 2, padY + headerH / 2);
        ctx.fillStyle = '#7b1a12';
        ctx.fillRect(0, padY + headerH, W, warnH);
        ctx.fillStyle = '#fff3f3';
        ctx.font      = '13px system-ui, sans-serif';
        ctx.fillText(getText('seed-print-warning'), W / 2, padY + headerH + warnH / 2);
        var gridTop = padY + headerH + warnH + 16;
        ctx.textBaseline = 'middle';
        words.forEach(function (word, i) {
            var col = i % cols;
            var row = Math.floor(i / cols);
            var x   = padX + col * cellW;
            var y   = gridTop + row * cellH;
            var cx  = x + cellW / 2;
            var cy  = y + cellH / 2;
            ctx.fillStyle = (row + col) % 2 === 0 ? '#f7f8fa' : '#eef0f4';
            if (ctx.roundRect) {
                ctx.beginPath(); ctx.roundRect(x + 2, y + 2, cellW - 4, cellH - 4, 6); ctx.fill();
            } else {
                ctx.fillRect(x + 2, y + 2, cellW - 4, cellH - 4);
            }
            ctx.strokeStyle = '#d0d4dc';
            ctx.lineWidth   = 1;
            if (ctx.roundRect) {
                ctx.beginPath(); ctx.roundRect(x + 2, y + 2, cellW - 4, cellH - 4, 6); ctx.stroke();
            } else {
                ctx.strokeRect(x + 2, y + 2, cellW - 4, cellH - 4);
            }
            ctx.fillStyle = '#9ca3af';
            ctx.font      = '11px system-ui, sans-serif';
            ctx.textAlign = 'left';
            ctx.fillText(i + 1, x + 10, cy);
            ctx.fillStyle = '#1a1a2e';
            ctx.font      = 'bold 15px system-ui, monospace';
            ctx.textAlign = 'center';
            ctx.fillText(word, cx + 8, cy);
        });
        var pathY = gridTop + gridH + 16;
        ctx.fillStyle    = '#f0f2f5';
        ctx.fillRect(padX, pathY, W - padX * 2, pathH);
        ctx.fillStyle    = '#374151';
        ctx.font         = '12px system-ui, monospace';
        ctx.textAlign    = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(getText('seed-path-label') + "  m/84'/0'/0'/0/0  (BIP84 native SegWit)", padX + 12, pathY + pathH / 2);
        var footerY = pathY + pathH;
        var now     = new Date();
        var dateStr = now.getFullYear() + '-' +
                      String(now.getMonth() + 1).padStart(2, '0') + '-' +
                      String(now.getDate()).padStart(2, '0');
        ctx.fillStyle    = '#9ca3af';
        ctx.font         = '11px system-ui, sans-serif';
        ctx.textAlign    = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText('Generated ' + dateStr, W - padX, footerY + footerH / 2);
        words.fill('');
        try {
            var link      = document.createElement('a');
            link.href     = canvas.toDataURL('image/png');
            link.download = 'seed-backup-' + dateStr + '.png';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        } catch (e) {
            window.open(canvas.toDataURL('image/png'), '_blank');
        }
    }
    window.seedExportPNG = seedExportPNG;
})();
