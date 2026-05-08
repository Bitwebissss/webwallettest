$.fn.qrcode = function(opts) {
    var text = (typeof opts === 'string') ? opts : opts.text;
    return this.each(function() {
        var container = this;
        var canvas = document.createElement('canvas');
        container.appendChild(canvas);
        QRCode.toCanvas(canvas, text, { 
            width: 256, 
            margin: 2, 
            color: { dark: '#000000', light: '#ffffff' } 
        }, function(err) {
            if (err) console.error('QR render error:', err);
        });
    });
};