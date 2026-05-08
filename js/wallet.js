(function() {
    'use strict';
    function applyTheme(mode) {
        var resolved = mode === 'auto'
            ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
            : mode;
        document.documentElement.setAttribute('data-bs-theme', resolved);
        var labels = { light: getText('theme-light'), dark: getText('theme-dark'), auto: getText('theme-auto') };
        $('#theme-label').text(labels[mode] || getText('theme-auto'));
    }
    function setTheme(mode) {
        try { localStorage.setItem('bte_cfg_theme', mode) } catch(e) {}
        applyTheme(mode);
    }
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function() {
        var saved; try { saved = localStorage.getItem('bte_cfg_theme') } catch(e) {}
        if ((saved || 'auto') === 'auto') applyTheme('auto');
    });
    function isValidBackendUrl(url) {
        try {
            var u = new URL(url)
            if (u.protocol !== 'https:' &&
                !(u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1'))) return false
            if (u.username || u.password) return false
            return true
        } catch(e) { return false }
    }
    function escHtml(s) {
        if (s == null) return ''
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;')
    }
    function wipeInputValue(selector) {
        $(selector).each(function() {
            if (this && typeof this.value === 'string') {
                this.value = '';
            }
        });
    }
    function clearSensitiveInputs() {
        wipeInputValue('#open-email');
        wipeInputValue('#open-password');
        wipeInputValue('#open-password-confirm');
        wipeInputValue('#passphrase');
        wipeInputValue('#pin-input');
        wipeInputValue('#restore-input');
        wipeInputValue('#transaction-broadcast-raw');
    }
    var stream        = null
    var scanVideo     = null
    var scanRafId     = null
    var scanSession   = 0
    var walletVersion = '0.5'
    var networkConfigs = {
        'BTE': {
            'uri':     'bitweb:',
            'title':   'Bitweb Wallet',
            'name':    'Main Network (BTE)',
            'api':     'https://api.bitwebcore.net',
            'ticker':  'BTE',
            'decimals': 8,
            'fee':     0.0001,
            'network': {
                'messagePrefix': '\x19Bitweb Signed Message:\n',
                'bip32':   { 'public': 0x0488b21e, 'private': 0x0488ade4 },
                'bech32':  'web',
                'pubKeyHash': 0x21,
                'scriptHash': 0x1E,
                'wif':     0x80
            },
            'maturity': {
                'coinbase': 100,
                'extended': {
                    'enabled': true,
                    'start':   1177,
                    'depth':   8000
                }
            }
        }
    }
    var blockExplorer = {
        'address': function(address) { return 'https://explorer.bitwebcore.net/address/' + address + '/' },
        'tx':      function(tx)      { return 'https://explorer.bitwebcore.net/tx/' + tx + '/' }
    }
    function seedExportPNG(mnemonic, getText) {
        if (!mnemonic) return
        var words = mnemonic.split(' ')
        var cols  = 4
        var rows  = Math.ceil(words.length / cols)
        var W       = 800
        var padX    = 44
        var padY    = 36
        var headerH = 72
        var warnH   = 46
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
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, W, H)
        ctx.fillStyle    = '#c0392b'
        ctx.fillRect(0, padY, W, headerH)
        ctx.fillStyle    = '#ffffff'
        ctx.font         = 'bold 22px system-ui, sans-serif'
        ctx.textAlign    = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(getText('seed-print-secret'), W / 2, padY + headerH / 2)
        ctx.fillStyle = '#7b1a12'
        ctx.fillRect(0, padY + headerH, W, warnH)
        ctx.fillStyle = '#fff3f3'
        ctx.font      = '13px system-ui, sans-serif'
        ctx.fillText(getText('seed-print-warning'), W / 2, padY + headerH + warnH / 2)
        var gridTop = padY + headerH + warnH + 16
        ctx.textBaseline = 'middle'
        words.forEach(function(word, i) {
            var col = i % cols
            var row = Math.floor(i / cols)
            var x   = padX + col * cellW
            var y   = gridTop + row * cellH
            var cx  = x + cellW / 2
            var cy  = y + cellH / 2
            ctx.fillStyle = (row + col) % 2 === 0 ? '#f7f8fa' : '#eef0f4'
            if (ctx.roundRect) {
                ctx.beginPath(); ctx.roundRect(x + 2, y + 2, cellW - 4, cellH - 4, 6); ctx.fill()
            } else {
                ctx.fillRect(x + 2, y + 2, cellW - 4, cellH - 4)
            }
            ctx.strokeStyle = '#d0d4dc'
            ctx.lineWidth   = 1
            if (ctx.roundRect) {
                ctx.beginPath(); ctx.roundRect(x + 2, y + 2, cellW - 4, cellH - 4, 6); ctx.stroke()
            } else {
                ctx.strokeRect(x + 2, y + 2, cellW - 4, cellH - 4)
            }
            ctx.fillStyle = '#9ca3af'
            ctx.font      = '11px system-ui, sans-serif'
            ctx.textAlign = 'left'
            ctx.fillText(i + 1, x + 10, cy)
            ctx.fillStyle = '#1a1a2e'
            ctx.font      = 'bold 15px system-ui, monospace'
            ctx.textAlign = 'center'
            ctx.fillText(word, cx + 8, cy)
        })
        var pathY = gridTop + gridH + 16
        ctx.fillStyle    = '#f0f2f5'
        ctx.fillRect(padX, pathY, W - padX * 2, pathH)
        ctx.fillStyle    = '#374151'
        ctx.font         = '12px system-ui, monospace'
        ctx.textAlign    = 'left'
        ctx.textBaseline = 'middle'
        ctx.fillText(getText('seed-path-label') + "  m/84'/0'/0'/0/0  (BIP84 native SegWit)", padX + 12, pathY + pathH / 2)
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
        try {
            var link      = document.createElement('a')
            link.href     = canvas.toDataURL('image/png')
            link.download = 'seed-backup-' + dateStr + '.png'
            document.body.appendChild(link)
            link.click()
            document.body.removeChild(link)
        } catch (e) {
            window.open(canvas.toDataURL('image/png'), '_blank')
        }
    }
    function destroyKeyMaterial(keyPair) {
        if (!keyPair) return;
        try {
            if (keyPair.privateKey && keyPair.privateKey instanceof Uint8Array) {
                keyPair.privateKey.fill(0);
            }
        } catch (ignore) { /* not critical */ }
        try {
            if (keyPair.__D && keyPair.__D instanceof Uint8Array) {
                keyPair.__D.fill(0);
            }
        } catch (ignore) { /* not critical */ }
    }
    function clearPrivKeyInput() {
        var pi = document.getElementById('wallet-privkey-input');
        if (pi) {
            pi.value = '•'.repeat(40);
            pi.type = 'password';
        }
    }
    function revealPrivKeyInput(wif) {
        var pi = document.getElementById('wallet-privkey-input');
        if (pi) { pi.value = wif; pi.type = 'text'; }
    }
    var Keystore = (function() {
        var keyPair = null;
        function getPublicKeyHex() {
            if (!keyPair) return '';
            return bitcoin.Buffer.from(keyPair.publicKey).toString('hex');
        }
        function getPublicKeyBytes() {
            return keyPair ? keyPair.publicKey : null;
        }
        function getWIF() {
            return keyPair ? keyPair.toWIF() : null;
        }
        function getPrivKeyHex() {
            if (!keyPair || !keyPair.privateKey) return null;
            return bitcoin.Buffer.from(keyPair.privateKey).toString('hex');
        }
        function signAllInputs(psbt) {
            if (!keyPair) throw new Error('Wallet locked');
            psbt.signAllInputs(keyPair);
        }
        function deriveAddress(type, pubKey) {
            if (!keyPair || !pubKey) return '';
            var network = getConfig()['network'];
            if (type === 'bech32') {
                return bitcoin.payments.p2wpkh({ pubkey: pubKey, network: network }).address;
            } else if (type === 'segwit') {
                var redeem = bitcoin.payments.p2wpkh({ pubkey: pubKey, network: network });
                return bitcoin.payments.p2sh({ redeem: redeem, network: network }).address;
            } else {
                return bitcoin.payments.p2pkh({ pubkey: pubKey, network: network }).address;
            }
        }
        function getScriptHex(type, pubKey) {
            if (!keyPair || !pubKey) return '';
            var network = getConfig()['network'];
            if (type === 'bech32') {
                return bitcoin.Buffer.from(bitcoin.payments.p2wpkh({ pubkey: pubKey, network: network }).output).toString('hex');
            } else if (type === 'segwit') {
                var redeem = bitcoin.payments.p2wpkh({ pubkey: pubKey, network: network });
                return bitcoin.Buffer.from(bitcoin.payments.p2sh({ redeem: redeem, network: network }).output).toString('hex');
            } else {
                return bitcoin.Buffer.from(bitcoin.payments.p2pkh({ pubkey: pubKey, network: network }).output).toString('hex');
            }
        }
        function getAllScriptHexes(pubKey) {
            var set = new Set();
            if (!keyPair || !pubKey) return set;
            var network = getConfig()['network'];
            set.add(bitcoin.Buffer.from(bitcoin.payments.p2wpkh({ pubkey: pubKey, network: network }).output).toString('hex').toLowerCase());
            var redeem = bitcoin.payments.p2wpkh({ pubkey: pubKey, network: network });
            set.add(bitcoin.Buffer.from(bitcoin.payments.p2sh({ redeem: redeem, network: network }).output).toString('hex').toLowerCase());
            set.add(bitcoin.Buffer.from(bitcoin.payments.p2pkh({ pubkey: pubKey, network: network }).output).toString('hex').toLowerCase());
            return set;
        }
        function getAllAddresses(pubKey) {
            var set = new Set();
            if (!keyPair || !pubKey) return set;
            var network = getConfig()['network'];
            try { set.add(bitcoin.payments.p2wpkh({ pubkey: pubKey, network: network }).address); } catch(e) {}
            try {
                var redeem = bitcoin.payments.p2wpkh({ pubkey: pubKey, network: network });
                set.add(bitcoin.payments.p2sh({ redeem: redeem, network: network }).address);
            } catch(e) {}
            try { set.add(bitcoin.payments.p2pkh({ pubkey: pubKey, network: network }).address); } catch(e) {}
            return set;
        }
        function isUnlocked() {
            return keyPair !== null;
        }
        function setKeyPair(kp) {
            if (keyPair) destroyKeyMaterial(keyPair);
            keyPair = kp;
        }
        function clear() {
            if (keyPair) {
                destroyKeyMaterial(keyPair);
                keyPair = null;
            }
        }
        return {
            getPublicKeyHex: getPublicKeyHex,
            getPublicKeyBytes: getPublicKeyBytes,
            getWIF: getWIF,
            getPrivKeyHex: getPrivKeyHex,
            signAllInputs: signAllInputs,
            deriveAddress: deriveAddress,
            getScriptHex: getScriptHex,
            getAllScriptHexes: getAllScriptHexes,
            getAllAddresses: getAllAddresses,
            isUnlocked: isUnlocked,
            setKeyPair: setKeyPair,
            clear: clear
        };
    })();
    var globalData = {
        status:          'locked',
        balance:         0,
        immatureBalance: 0,
        height:          0,
        address:         undefined,
        scriptHex:       undefined,
        pubKeyHex:       undefined,
        pubKey:          null,
        rfee:            getConfig()['fee'],
        utxos:           [],
        coinControl:     false,
        selectedUtxos:   null,
        tx:              { amount: 0, outputs: [], fee: 0 },
        _lastRendered:   { balance: -1, immature: -1, utxoFingerprint: '' },
        resetTx: function() {
            this.tx = { amount: 0, outputs: [], fee: 0 };
        },
        clear: function() {
            this.status          = 'locked';
            this.address         = '';
            this.scriptHex       = undefined;
            this.pubKeyHex       = undefined;
            if (this.pubKey instanceof Uint8Array) this.pubKey.fill(0);
            this.pubKey          = null;
            this.allScriptHexes  = null;
            this.allAddresses    = null;
            this.balance         = 0;
            this.immatureBalance = 0;
            this.height          = 0;
            this.utxos           = [];
            this.coinControl     = false;
            this.selectedUtxos   = null;
            this._lastRendered   = { balance: -1, immature: -1, utxoFingerprint: '' };
            this.resetTx();
        }
    };
    var messages = initMessages()
    var STORAGE_KEY_PUB  = 'bte_wallet_pubkey';
    var STORAGE_KEY_PRIV = 'bte_wallet_privkey';
    var STORAGE_KEY_SEED = 'bte_wallet_seed';
    function hasSeedBackup() {
        return localStorage.getItem(STORAGE_KEY_SEED) !== null;
    }
    function clearSeedState() {
        _seedState.mnemonic = '';
		_seedState.strength = 256;
        _seedState.verifyPositions = [];
    }
    async function saveEncrypted(storageKey, plaintext, pin) {
        var enc  = new TextEncoder();
        var salt = crypto.getRandomValues(new Uint8Array(16));
        var iv   = crypto.getRandomValues(new Uint8Array(12));
        var key  = await deriveKey(pin, salt);
        var ct   = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, enc.encode(plaintext));
        localStorage.setItem(storageKey, JSON.stringify({
            salt: Array.from(salt),
            iv:   Array.from(iv),
            data: Array.from(new Uint8Array(ct))
        }));
    }
    async function loadEncrypted(storageKey, pin) {
        var raw = localStorage.getItem(storageKey);
        if (!raw) return null;
        var blob = JSON.parse(raw);
        var key  = await deriveKey(pin, new Uint8Array(blob.salt));
        try {
            var pt = await crypto.subtle.decrypt(
                { name: 'AES-GCM', iv: new Uint8Array(blob.iv) },
                key,
                new Uint8Array(blob.data)
            );
            var ptView  = new Uint8Array(pt);
            var decoded = new TextDecoder().decode(pt);
            ptView.fill(0);
            return decoded;
        } catch(e) {
            return null;
        }
    }
    async function saveWalletWif(pin) {
        var pubkey  = globalData.pubKeyHex;
        var privHex = Keystore.getPrivKeyHex();
        await saveEncrypted(STORAGE_KEY_PUB,  pubkey,   pin);
        await saveEncrypted(STORAGE_KEY_PRIV, privHex,  pin);
        localStorage.removeItem(STORAGE_KEY_SEED);
        privHex = '';
    }
    async function saveWalletBip39(mnemonic, pin) {
        var pubkey  = globalData.pubKeyHex;
        var privHex = Keystore.getPrivKeyHex();
        await saveEncrypted(STORAGE_KEY_PUB,  pubkey,   pin);
        await saveEncrypted(STORAGE_KEY_PRIV, privHex,  pin);
        await saveEncrypted(STORAGE_KEY_SEED, mnemonic, pin);
        mnemonic = '';
        privHex  = '';
    }
    async function loadWallet(pin) {
        var pubHex  = await loadEncrypted(STORAGE_KEY_PUB,  pin);
        var privHex = await loadEncrypted(STORAGE_KEY_PRIV, pin);
        if (!pubHex || !privHex) return null;
        return { pubkey: pubHex, privHex: privHex };
    }
    var AUTO_LOCK_MS   = 20 * 60 * 1000
    var _autoLockTimer = null
    function _resetAutoLock() {
        if (!Keystore.isUnlocked()) return;
        clearTimeout(_autoLockTimer);
        _autoLockTimer = setTimeout(function() {
            closeWallet();
            var msg = (typeof getText === 'function') ? getText('auto-locked') : '';
            showMessage(msg || 'Wallet locked after inactivity');
        }, AUTO_LOCK_MS);
    }
    function _stopAutoLock() {
        clearTimeout(_autoLockTimer)
        _autoLockTimer = null
    }
    async function deriveKey(pin, salt) {
        var enc = new TextEncoder()
        var km  = await crypto.subtle.importKey(
            'raw', enc.encode(pin), { name: 'PBKDF2' }, false, ['deriveKey']
        )
        return crypto.subtle.deriveKey(
            { name: 'PBKDF2', salt: salt, iterations: 200000, hash: 'SHA-256' },
            km,
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt', 'decrypt']
        )
    }            
    function hasSavedWallet() {
        return localStorage.getItem(STORAGE_KEY_PRIV) !== null;
    }
    function forgetSavedWallet() {
        _stopAutoLock();
        stopStream();
        wsDisconnect();
        [STORAGE_KEY_PUB, STORAGE_KEY_PRIV, STORAGE_KEY_SEED].forEach(function(k) {
            try { localStorage.removeItem(k); } catch(e) {}
        });
        try {
            Object.keys(localStorage).forEach(function(k) {
                if (k.indexOf('bte_history_') === 0 || k.indexOf('bte_utxo_') === 0 || k.indexOf('bte_wallet_') === 0) {
                    localStorage.removeItem(k);
                }
            });
        } catch(e) {}
        clearSensitiveInputs();
        clearSeedState();
        Keystore.clear();
        globalData.clear();
        clearPrivKeyInput();
        $('#wallet-privkey-copy-btn').addClass('d-none');
        $('#toggle-wallet-privkey').text(getText('show'));
        $('#wallet-keys-pubkey input').val('');
        $('#wallet-keys-script input').val('');
        $('#wallet-address').text('');
        $('#qr-code-addres').empty();
        resetTxForm();
        _hideSeedReveal();
        $('#wallet-block').addClass('d-none');
        updateSavedWalletUI();
        setHomeTitle();
    }
    function updateSavedWalletUI() {
        if (hasSavedWallet()) {
            $('#pin-login-block').removeClass('d-none')
            $('#open-block').addClass('d-none')
            $('#forget-wallet-section').removeClass('d-none')
        } else {
            $('#pin-login-block').addClass('d-none')
            $('#open-block').removeClass('d-none')
            $('#forget-wallet-section').addClass('d-none')
        }
    }
    var _pinResolve   = null
    var _pinValidator = null
    function askPin(title, desc, validator, mandatory) {
        return new Promise(function(resolve) {
            _pinResolve   = resolve
            _pinValidator = validator || null
            $('#pin-modal-title').text(title)
            $('#pin-modal-desc').text(desc)
            $('#pin-input').val('')
            $('#pin-error').addClass('d-none')
            if (mandatory) {
                $('#pin-cancel').addClass('d-none')
            } else {
                $('#pin-cancel').removeClass('d-none')
            }
            $('#pin-modal').modal({ backdrop: 'static', keyboard: false })
            $('#pin-modal').modal('show')
            setTimeout(function() { $('#pin-input').focus() }, 400)
        })
    }
    async function askPinSetup() {
        var pin = await askPin(
            getText('pin-create-title'),
            getText('pin-create-desc'),
            function(p) { return (!p || p.length < 6) ? getText('pin-too-short') : null },
            false
        )
        if (pin === null) return null
        var confirmed = await askPin(
            getText('pin-confirm-title'),
            getText('pin-confirm-desc'),
            function(p) { return (p !== pin) ? getText('pin-mismatch') : null },
            false
        )
        return confirmed
    }
    function initMessages() {
        return {
            'settings': {
                'typeSwitched':    function(type) { return getText('address-type-changed') + ' <b>' + escHtml(type) + '</b>' },
                'backendSwitched': function(url)  { return getText('backend-switched') + ' <b>' + escHtml(url) + '</b>' },
                'backendNotWorking': function(url) { return '<b>' + escHtml(url) + '</b> ' + getText('backend-down') }
            },
            'error': {
                'bad-utxo':           getText('bad-utxo'),
                'balance-load-failed': getText('balance-load-failed'),
                'not-enough-funds':   getText('not-enough-funds'),
                'not-valid-address':  getText('not-valid-address'),
                'not-valid-amount':   getText('not-valid-amount'),
                'not-valid-fee':      getText('not-valid-fee'),
                'bad-priv-key':       getText('bad-priv-key'),
                'not-enough-utxo':    getText('not-enough-utxo'),
                'broadcast-failed':   getText('broadcast-failed'),
                'pass-not-match':     getText('pass-not-match'),
                'pass-too-short':     getText('pass-too-short'),
                'small-fee':          getText('small-fee') + ' ' + getConfig()['fee'] + ' ' + getConfig()['ticker'] + '!'
            },
            'tx': {
                'loading-utxo': getText('loading-utxo'),
                'generating':   getText('transaction-creation'),
                'success':      getText('transaction-broadcasted')
            },
            'title': {
                'sure':       getText('send-sure'),
                'processing': getText('send-processing'),
                'success':    getText('success'),
                'failed':     getText('failed')
            },
            'misc': {
                'outputAdded': function(address) {
                    return getText('address') + ' ' + '<b class="break-word">' + escHtml(address) + '</b>' + ' ' + getText('outputs-added')
                }
            }
        }
    }
    function initLang() {
        var language; try { language = localStorage.getItem('bte_cfg_language') } catch(e) {}
        var set_lang = 'en'
        if (language == null || walletLanguages[language] == undefined) {
            var user_lang = navigator.language.substr(0, 2)
            if (user_lang in walletLanguages) set_lang = user_lang
            try { localStorage.setItem('bte_cfg_language', set_lang) } catch(e) {}
            language = set_lang
        }
        var $menu = $('#lang-dropdown-menu')
        $menu.empty()
        for (var key in walletLanguages) {
            var isActive = (key === language) ? ' active' : ''
            $menu.append(
                '<li><a class="dropdown-item lang-switch-item' + isActive + '" href="#" data-lang="' + escHtml(key) + '">' +
                escHtml(walletLanguages[key]['lang-alias']) + '</a></li>'
            )
        }
        $('#lang-label').text('🌐 ' + (walletLanguages[language] ? walletLanguages[language]['lang-alias'] : language))
        $('[tkey]').each(function() {
            if (['INPUT', 'TEXTAREA'].indexOf($(this).prop('tagName')) >= 0) {
                $(this).attr('placeholder', getText($(this).attr('tkey')))
            } else {
                $(this).html(getText($(this).attr('tkey')))
            }
        })
        $('[data-tkey-title]').each(function() {
            $(this).attr('title', getText($(this).attr('data-tkey-title')))
        })
        messages = initMessages()
        setHomeTitle()
        return language
    }
    function getText(token) {
        var language; try { language = localStorage.getItem('bte_cfg_language') } catch(e) {}
        if (language == undefined) language = initLang()
        if (token in walletLanguages[language]) return walletLanguages[language][token]
        return walletLanguages['en'][token]
    }
    function getConfig() {
        var network; try { network = localStorage.getItem('bte_cfg_network') } catch(e) {}
        if (network == null || networkConfigs[network] == undefined) {
            network = Object.keys(networkConfigs)[0]
            try { localStorage.setItem('bte_cfg_network', network) } catch(e) {}
        }
        return networkConfigs[network]
    }
    function switchConfig(network, page) {
        page = page || ''
        network = network.toUpperCase()
        if (networkConfigs[network] != undefined && networkConfigs[network] != getConfig()) {
            try { localStorage.setItem('bte_cfg_network', network) } catch(e) {}
            closeWallet()
            switchBackend(networkConfigs[network]['api'])
        }
        switchPage(page)
    }
    function getAddressType() {
        var type; try { type = localStorage.getItem('bte_cfg_type') } catch(e) {}
        if (type == null || !['bech32', 'segwit', 'legacy'].includes(type)) {
            type = 'bech32'
            try { localStorage.setItem('bte_cfg_type', type) } catch(e) {}
        }
        return type
    }
    function switchAddressType(type) {
        if (['bech32', 'segwit', 'legacy'].includes(type)) try { localStorage.setItem('bte_cfg_type', type) } catch(e) {}
    }
    function getBackend() {
        var backend; try { backend = localStorage.getItem('bte_cfg_backend') } catch(e) {}
        if (backend == null) {
            backend = getConfig()['api']
            try { localStorage.setItem('bte_cfg_backend', backend) } catch(e) {}
        }
        return backend
    }
    function switchBackend(url) {
        if (!isValidBackendUrl(url)) {
            showMessage(messages.settings.backendNotWorking(url))
            $('#wallet-backend input').val(getBackend())
            return
        }
        Promise.resolve($.ajax({ 'url': url + '/info' })).then(function() {
            try { localStorage.setItem('bte_cfg_backend', url) } catch(e) {}
            showMessage(messages.settings.backendSwitched(url))
        }).catch(function() {
            showMessage(messages.settings.backendNotWorking(url))
            $('#wallet-backend input').val(getBackend())
        })
    }
    function copyToClipboard(text, $btn) {
        var doFeedback = function(ok) {
            var $icon = $btn.find('.fa-solid, .fa-regular, .fa-brands').first();
            var origClass = $icon.attr('class');
            if ($icon.length) {
                $icon.attr('class', 'fa-solid ' + (ok ? 'fa-check' : 'fa-times'));
            }
            $btn.addClass(ok ? 'btn-success' : 'btn-danger').removeClass('btn-outline-secondary');
            setTimeout(function() {
                if ($icon.length) $icon.attr('class', origClass);
                $btn.removeClass('btn-success btn-danger').addClass('btn-outline-secondary');
            }, 1500);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(function() {
                doFeedback(true);
            }).catch(function() {
                doFeedback(false);
            });
        } else {
            var ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity  = '0';
            document.body.appendChild(ta);
            ta.focus(); ta.select();
            var ok = false;
            try { ok = document.execCommand('copy'); } catch(e) {}
            document.body.removeChild(ta);
            doFeedback(ok);
        }
    }
    function getRequiredMaturity(coinHeight) {
        var cfg = getConfig()['maturity']
        if (!cfg) return 100
        var m   = cfg.coinbase || 100
        var ext = cfg.extended
        if (ext && ext.enabled) {
            var EXT_END = ext.start + ext.depth
            if (coinHeight >= ext.start && coinHeight < EXT_END) {
                return (EXT_END - coinHeight) + m
            }
        }
        return m
    }
    function isUtxoMature(utxo, currentHeight) {
        if (!utxo.coinbase) return true
        if (utxo.height === 0) return false
        var required = getRequiredMaturity(utxo.height)
        return (currentHeight - utxo.height) >= required
    }
    function blocksToMature(utxo, currentHeight) {
        if (!utxo.coinbase || utxo.height === 0) return 0
        var required = getRequiredMaturity(utxo.height)
        return Math.max(0, required - (currentHeight - utxo.height))
    }
    var UTXO_CACHE_TTL = 60000  // ms
    function loadUtxoCache(address) {
        try {
            var raw = localStorage.getItem('bte_utxo_' + address)
            if (!raw) return null
            var c = JSON.parse(raw)
            if (Date.now() - c.ts > UTXO_CACHE_TTL) return null
            return c
        } catch(e) { return null }
    }
    function saveUtxoCache(address, utxos, height) {
        try {
            localStorage.setItem('bte_utxo_' + address, JSON.stringify({
                utxos: utxos, height: height, ts: Date.now()
            }))
        } catch(e) {}
    }
    function clearUtxoCache(address) {
        try { localStorage.removeItem('bte_utxo_' + address) } catch(e) {}
    }
    function routePage() {
        var urlParams = readParams()
        if (window.location.hash == '') window.location.replace(window.location.href.split('#')[0] + '#/')
        if (urlParams[0] == '#') {
            var pageName    = urlParams[1] != '' ? urlParams[1] : 'homepage'
            var templateName = '#' + pageName
            $('.router-link').removeClass('active')
            $('.router-link[data-route=' + pageName + ']').addClass('active')
            if ($('.router-page:visible').attr('id') != urlParams[1]) {
                $('div.router-page').hide()
                if ($(templateName).length) $(templateName).show()
            }
            switch(pageName) {
                case 'homepage':  setHomeTitle(); 
                    break
                    case 'broadcast': setTitle(getText('broadcast-transaction')); 
                        break
                case 'network':
                    var network = urlParams[2]
                    if (network != undefined) switchConfig(network)
                    break
                default: switchPage(); 
                    break
            }
        }
    }
    function switchPage(url, params) {
        url    = url    || ''
        params = params || []
        var p  = params.length > 0 ? '/' + params.join('/') : ''
        window.location.hash = '#/' + url + p
    }
    function readParams() { return window.location.hash.split('/') }
    function setTitle(title) { document.title = title + ' | ' + getConfig()['title'] }
    function transactionBroadcast(rawtx) {
        return Promise.resolve($.ajax({
            'method': 'POST',
            'url':    getBackend() + '/broadcast',
            'data':   { 'raw': rawtx }
        }))
    }
    function estimateFee() {
        return Promise.resolve($.ajax({ 'url': getBackend() + '/fee' }))
    }
    function _applyUtxoData() {
        var immature = 0
        globalData.utxos.forEach(function(u) {
            if (!u.mature) immature += u.value
        })
        globalData.immatureBalance = immature
        var fp = globalData.utxos.map(function(u) {
            return u.txid + ':' + u.index + ':' + (u.mature ? 1 : 0)
        }).join('|')
        var fpChanged = fp !== globalData._lastRendered.utxoFingerprint
        if (fpChanged) {
            globalData._lastRendered.utxoFingerprint = fp
            renderCoinControl()
        }
        _renderBalanceDisplay()
    }
    function amountFormat(amount) {
        var decimals = getConfig()['decimals']
        var sats = String(Math.round(Math.abs(Number(amount))))
        while (sats.length <= decimals) sats = '0' + sats
        var intPart  = sats.slice(0, sats.length - decimals) || '0'
        var fracPart = sats.slice(sats.length - decimals)
        fracPart = fracPart.replace(/0+$/, '')
        return fracPart.length > 0 ? intPart + '.' + fracPart : intPart
    }
    function showMessage(message) {
        $('#error-message').html(message)
        $('#error-message').removeClass('d-none')
        setTimeout(function() { $('#error-message').addClass('d-none') }, 3400)
    }
    function showSendError(message) {
        $('#send-modal-error').html(message).removeClass('d-none')
        $('#confirm-screen').addClass('d-none')
        $('#status-screen').addClass('d-none')
        $('#send-cancel').removeClass('disabled d-none')
        $('#send-confirm').addClass('d-none')
        $('#send-close-footer').addClass('d-none disabled')
        if (!$('#send-modal').hasClass('show')) {
            $('#send-title').text(messages.title['sure'] || 'Send')
            $('#send-modal').modal('show')
        }
    }
    function showQrAddress(text) {
        $('#qr-code-addres').empty()
        $('#qr-code-addres').qrcode(text)
    }
    function _renderBalanceDisplay() {
        var total    = globalData.balance
        var immature = globalData.immatureBalance
        var avail    = Math.max(0, total - immature)
        var lr = globalData._lastRendered
        if (lr.balance === total && lr.immature === immature) return
        lr.balance = total
        lr.immature = immature
        var ticker = getConfig()['ticker']
        $('.wallet-balance .amount').text(amountFormat(avail))
        $('.wallet-balance .ticker').text(ticker)
        var immatureText = immature > 0
            ? amountFormat(immature) + ' ' + ticker
            : ''
        $('#immature-balance-row-main, #immature-balance-row').each(function() {
            if (immature > 0) {
                $(this).find('.immature-amount').text(immatureText)
                $(this).removeClass('d-none')
            } else {
                $(this).addClass('d-none')
            }
        })
        validateSendForm()
    }
    function setHomeTitle() {
        if (Keystore.isUnlocked()) setTitle(getText('address') + ' ' + globalData.address)
        else setTitle(getText('open-wallet'))
    }
    var _seedState = { mnemonic: '', strength: 256, verifyPositions: [] }
    var HISTORY_LIMIT = 10
    function loadHistory() {
        var key = 'bte_history_' + globalData.address
        try { return JSON.parse(localStorage.getItem(key) || '[]') } catch (e) { return [] }
    }
    function saveHistory(txs) {
        if (!globalData.address) return
        try { localStorage.setItem('bte_history_' + globalData.address, JSON.stringify(txs)) } catch (e) {}
    }
    function annotateTx(txMeta, txDetail) {
        var vin   = txDetail.vin  || []
        var vout  = txDetail.vout || []
        var myPub = (globalData.pubKeyHex || '').toLowerCase()
        var weAreSender = vin.some(function(input) {
            var wit = input.txinwitness || []
            if (wit[1] && wit[1].toLowerCase() === myPub) return true
            var sig = (input.scriptSig && input.scriptSig.hex)
                ? input.scriptSig.hex.toLowerCase() : ''
            if (sig.length >= 68 && sig.slice(-68) === '21' + myPub) return true
            return false
        })
        var received = 0, sentToOthers = 0
        vout.forEach(function(o) {
            var sat = (o.value_sat != null)
                ? o.value_sat
                : Math.round((o.value || 0) * 1e8)
            var hex = (o.scriptPubKey && o.scriptPubKey.hex)
                ? o.scriptPubKey.hex.toLowerCase() : ''
            var isOurs = hex
                ? (globalData.allScriptHexes
                    ? globalData.allScriptHexes.has(hex)
                    : hex === (globalData.scriptHex || '').toLowerCase())
                : false
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
    function updateHistory() {
        if (globalData.status !== 'unlocked') return
        var requestedAddress = globalData.address
        $('#history-list').html(
            '<div class="text-muted text-center py-3 small">' +
            escHtml(getText('history-loading')) + '</div>'
        )
        fetch(getBackend() + '/history/' + requestedAddress)
        .then(function(r) { return r.json() })
        .then(function(data) {
            if (!data || data.error != null) {
                $('#history-list').html(
                    '<div class="text-danger text-center py-3 small">' +
                    escHtml(getText('history-failed')) + '</div>'
                )
                return
            }
            var all    = data.result || []
            var total  = all.length
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
                dirLabel = '<span class="font-weight-bold text-success tx-dir-label">&#x2193; +' + escHtml(String(amt)) + ' ' + escHtml(ticker) + '</span>'
            } else if (dir === 'out') {
                dirLabel = '<span class="font-weight-bold text-danger tx-dir-label">&#x2191; -' + escHtml(String(amt)) + ' ' + escHtml(ticker) + '</span>'
            } else if (dir === 'self') {
                dirLabel = '<span class="font-weight-bold text-info tx-dir-label">&#x21C5; '  + escHtml(String(amt)) + ' ' + escHtml(ticker) + '</span>'
            } else {
                dirLabel = '<span class="text-muted tx-dir-label">— ? '       + escHtml(ticker) + '</span>'
            }
            var safeHash  = escHtml(tx.tx_hash || '')
            var txUrl     = escHtml(blockExplorer.tx(tx.tx_hash || ''))
            var shortHash = safeHash.substr(0, 10) + '…' + safeHash.substr(-6)
            html += '<div class="history-item d-flex align-items-center border-bottom history-item-inner">' +
                dirLabel +
                '<div class="font-monospace text-truncate flex-grow-1 history-tx-hash">' +
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
    function _hideSeedReveal() {
        $('#wallet-seed-hidden').removeClass('d-none')
        $('#wallet-seed-revealed').addClass('d-none')
        $('#wallet-seed-grid').empty()
                    }
    function seedReset() {
        $('#seed-entry').removeClass('d-none')
        $('#seed-create').addClass('d-none')
        $('#seed-restore').addClass('d-none')
        $('#seed-create-step1').removeClass('d-none')
        $('#seed-create-step2').addClass('d-none')
        $('#seed-word-grid').empty()
        $('#seed-generate-warning, #seed-verify-error').addClass('d-none')
        $('#seed-verify-fields').empty()
        clearSensitiveInputs()
        $('#restore-word-error').addClass('d-none')
        $('#restore-path').val("m/84'/0'/0'/0/0")
        $('#restore-advanced').removeClass('show')
        clearSeedState();
    }
    function _showWalletUI() {
        var pubkey = globalData.pubKeyHex;
        var addressType = getAddressType();
        var redeem = '';
        if (addressType !== 'legacy') {
            redeem = '0014' + bitcoin.Buffer.from(
                bitcoin.payments.p2wpkh({ pubkey: globalData.pubKey, network: getConfig()['network'] }).hash
            ).toString('hex');
        }
        $('#wallet-keys-pubkey input').val(pubkey);
        clearPrivKeyInput();
        $('#wallet-privkey-copy-btn').addClass('d-none');
        $('#toggle-wallet-privkey').text(getText('show'));
        $('#wallet-keys-script input').val(redeem);
        if (addressType === 'legacy') {
            $('#wallet-keys-script').addClass('d-none');
        } else {
            $('#wallet-keys-script').removeClass('d-none');
        }
        if (hasSeedBackup()) {
            $('#wallet-keys-seed').removeClass('d-none');
        } else {
            $('#wallet-keys-seed').addClass('d-none');
        }
        _hideSeedReveal();
        $('#wallet-address').text(globalData.address);
        $('#pin-login-block').addClass('d-none');
        $('#open-block').addClass('d-none');
        $('#wallet-block').removeClass('d-none');
        $('#send-fee').attr('placeholder', getText('fee') + ' (' + getText('recommended') + ' ' + globalData.rfee + ' ' + getConfig()['ticker'] + ')');
        showQrAddress(getConfig()['uri'] + globalData.address);
        renderHistory(loadHistory());
        globalData.balance = 0;
        globalData.immatureBalance = 0;
        globalData.utxos = [];
        _renderBalanceDisplay();
        if (_ws && _wsActive) {
            _ws.emit('subscribe', { address: globalData.address });
        }
    }
    async function openWallet(offerPin, bip39Mnemonic) {
        if (offerPin && !hasSavedWallet()) {
            var pin = await askPinSetup();
            if (pin === null) {
                Keystore.clear();
                seedReset();
                return;
            }
            globalData.pubKeyHex = Keystore.getPublicKeyHex();
            globalData.pubKey    = new Uint8Array(Keystore.getPublicKeyBytes());

            if (bip39Mnemonic) {
                await saveWalletBip39(bip39Mnemonic, pin);
            } else {
                await saveWalletWif(pin);
            }
            showMessage(getText('wallet-saved'));
            updateSavedWalletUI();
        }
        globalData.status         = 'unlocked';
        globalData.address        = Keystore.deriveAddress(getAddressType(), globalData.pubKey);
        globalData.scriptHex      = Keystore.getScriptHex(getAddressType(), globalData.pubKey);
        globalData.allScriptHexes = Keystore.getAllScriptHexes(globalData.pubKey);
        globalData.allAddresses   = Keystore.getAllAddresses(globalData.pubKey);

        _showWalletUI();
        wsConnect();
        setHomeTitle();
        _resetAutoLock();
    }
    function closeWallet() {
        _stopAutoLock();
        stopStream();
        wsDisconnect();
        clearPrivKeyInput();
        $('#wallet-privkey-copy-btn').addClass('d-none');
        $('#toggle-wallet-privkey').text(getText('show'));
        $('#wallet-keys-pubkey input').val('');
        $('#wallet-keys-script input').val('');
        $('#wallet-address').text('');
        $('#qr-code-addres').empty();
        resetTxForm();
        _hideSeedReveal();
        clearSensitiveInputs();
        clearSeedState();
        Keystore.clear();
        globalData.clear();
        $('#wallet-block').addClass('d-none');
        updateSavedWalletUI();
        setHomeTitle();
    }
    function renderCoinControl() {
        var utxos  = globalData.utxos
        var height = globalData.height
        var tbody  = $('#coin-control-tbody')
        tbody.empty()
        if (utxos.length === 0) {
            tbody.append('<tr><td colspan="5" class="text-muted text-center">' + escHtml(getText('coin-control-no-utxo')) + '</td></tr>')
            _updateCoinControlInfo()
            return
        }
        utxos.forEach(function(u, idx) {
            var key      = escHtml(u.txid + ':' + u.index)
            var checked  = !globalData.coinControl || (globalData.selectedUtxos && globalData.selectedUtxos.has(u.txid + ':' + u.index))
            var mature   = u.mature
            var isCbase  = u.coinbase
            var disabled = (!globalData.coinControl || !mature) ? 'disabled' : ''
            var rowClass = (!mature) ? 'text-muted' : ''
            var status   = ''
            if (!mature) {
                status = '<span class="text-warning" title="' + escHtml(getText('coin-control-matures-in')) + ' ' + escHtml(String(u.blocksLeft)) + ' ' + escHtml(getText('coin-control-blocks')) + '">' +
                    '<span class="fa-solid fa-lock"></span> ' + escHtml(String(u.blocksLeft)) + ' blk</span>'
            } else {
                status = '<span class="text-success"><span class="fa-solid fa-unlock"></span> ' + escHtml(getText('coin-control-mature')) + '</span>'
            }
            var typeLabel = isCbase
                ? '<span class="badge text-bg-secondary">' + escHtml(getText('coin-control-coinbase')) + '</span>'
                : '<span class="badge text-bg-secondary">' + escHtml(getText('coin-control-regular')) + '</span>'
            var shortTx   = escHtml(u.txid.substr(0,6)) + '…' + escHtml(u.txid.substr(-4))
            var amt       = amountFormat(u.value)
            tbody.append(
                '<tr class="' + rowClass + '" data-key="' + key + '">' +
                '<td><input type="checkbox" class="cc-utxo-check" data-key="' + key + '"' +
                (checked ? ' checked' : '') + (disabled ? ' disabled' : '') + (!mature ? ' title="' + escHtml(getText('coin-control-immature-title')) + '"' : '') + '></td>' +
                '<td class="font-monospace">' + escHtml(String(amt)) + '</td>' +
                '<td>' + (height > 0 && u.height > 0 ? escHtml(String(height - u.height + 1)) : '—') + '</td>' +
                '<td>' + typeLabel + '</td>' +
                '<td>' + status + '</td>' +
                '</tr>'
            )
        })
        _updateCoinControlInfo()
    }
    function _updateCoinControlInfo() {
        if (!globalData.coinControl || !globalData.selectedUtxos) {
            $('#coin-control-selected-info').text('')
            return
        }
        var total = 0, count = 0
        globalData.utxos.forEach(function(u) {
            var key = u.txid + ':' + u.index
            if (globalData.selectedUtxos.has(key)) { total += u.value; count++ }
        })
        $('#coin-control-selected-info').text(
            count + ' ' + getText('coin-control-selected') + ' — ' + amountFormat(total) + ' ' + getConfig()['ticker']
        )
    }
    function showConfirmation(amount, totalSats, feeSats, outputsSats) {
        $('#confirm-amount').text(amount + ' ' + getConfig()['ticker'])
        $('#send-modal-error').addClass('d-none').html('')
        $('#send-modal').modal('show')
        $('#send-title').text(messages.title['sure'])
        $('#send-cancel').removeClass('disabled d-none')
        $('#send-confirm').removeClass('disabled d-none')
        $('#send-close-footer').addClass('d-none disabled')
        $('#confirm-screen').removeClass('d-none')
        $('#status-screen').addClass('d-none')
        $('#status-screen span').html('')
        globalData.tx.outputs = []
        $.each($('#send-outputs .send-outputs-item'), function(key, item) {
            var address = $('[name="send-address"]', item).val().trim()
            var amtSats = parseAmountSats($('[name="send-ammount"]', item).val())
            globalData.tx.outputs.push({ 'address': address, 'amount': amtSats })
        })
        globalData.tx.amount = totalSats
        globalData.tx.fee    = feeSats
    }
    function getRawTx(txid) {
        return fetch(getBackend() + '/rawtx/' + txid)
            .then(function(r) { return r.json() })
            .then(function(data) {
                if (data.error !== null) throw new Error('rawtx fetch failed')
                return data.result
            })
    }
    function sendTransaction() {
        var network = getConfig()['network'];
        var outputs = globalData.tx.outputs;
        var amount  = globalData.tx.amount;
        var address = globalData.address;
        var psbt = new bitcoin.Psbt({ network: network });
        psbt.setVersion(2);
        $('#send-cancel').addClass('disabled');
        $('#send-confirm').addClass('disabled');
        $('#confirm-screen').addClass('d-none');
        $('#status-screen').removeClass('d-none');
        $('#send-title').text(messages.title['processing']);
        $('#status-screen .extra-info').empty();
        $('#status-screen span').html(messages.tx['generating']);
        for (var i = 0; i < outputs.length; i++) {
            psbt.addOutput({ address: outputs[i].address, value: BigInt(outputs[i].amount) });
        }
        $('#status-screen span').html(messages.tx['loading-utxo']);
        var doSend = function(utxos) {
            var spendable;
            if (globalData.coinControl && globalData.selectedUtxos && globalData.selectedUtxos.size > 0) {
                spendable = utxos.filter(function(u) {
                    return globalData.selectedUtxos.has(u.txid + ':' + u.index) && u.mature;
                });
            } else {
                spendable = utxos.filter(function(u) { return u.mature; });
            }
            var value     = 0;
            var inputMeta = [];
            var pubkey    = globalData.pubKey;
            for (var i = 0; i < spendable.length; i++) {
                var u      = spendable[i];
                var script = bitcoin.Buffer.from(u.script, 'hex');
                var type   = getScriptType(script);
                if (type === 'bech32') {
                    var p2wpkh = getP2WPKHScript(pubkey);
                    psbt.addInput({
                        hash:        u.txid,
                        index:       u.index,
                        witnessUtxo: { script: p2wpkh.output, value: BigInt(u.value) }
                    });
                    inputMeta.push({ type: 'bech32' });
                } else if (type === 'segwit') {
                    var p2wpkh2 = getP2WPKHScript(pubkey);
                    var p2sh2   = getP2SHScript(p2wpkh2);
                    psbt.addInput({
                        hash:         u.txid,
                        index:        u.index,
                        witnessUtxo:  { script: p2sh2.output, value: BigInt(u.value) },
                        redeemScript: p2wpkh2.output
                    });
                    inputMeta.push({ type: 'segwit' });
                } else if (type === 'legacy') {
                    psbt.addInput({ hash: u.txid, index: u.index });
                    inputMeta.push({ type: 'legacy', psbtIdx: inputMeta.length, txid: u.txid });
                } else {
                    showSendError(messages.error['bad-utxo']);
                    return;
                }
                value += u.value;
                if (value >= amount) break;
            }
            if (value < amount) {
                showSendError(messages.error['not-enough-funds']);
                return;
            }
            var legacyFetches = inputMeta
                .filter(function(m) { return m.type === 'legacy'; })
                .map(function(m) {
                    return getRawTx(m.txid).then(function(rawHex) {
                        psbt.updateInput(m.psbtIdx, {
                            nonWitnessUtxo: bitcoin.Buffer.from(rawHex, 'hex')
                        });
                    });
                });
            Promise.all(legacyFetches).then(function() {
                var change = value - amount;
                if (change > 0) psbt.addOutput({ address: address, value: BigInt(change) });
                Keystore.signAllInputs(psbt);
                psbt.finalizeAllInputs();
                var tx = psbt.extractTransaction();
                transactionBroadcast(tx.toHex()).then(function(data) {
                    if (data.error == null) {
                        clearUtxoCache(address);
                        $('#status-screen span').html(
                            '<a href="' + escHtml(blockExplorer.tx(data.result)) + '" target="_blank" rel="noopener noreferrer">' + escHtml(data.result) + '</a>'
                        );
                        $('#send-title').text(messages.title['success']);
                    } else {
                        $('#status-screen span').html(messages.error['broadcast-failed']);
                        $('#send-title').text(messages.title['failed']);
                        $('#status-screen .extra-info').html(
                            '<div class="mt-3"><textarea class="form-control" readonly cols="30" rows="10">' + escHtml(data.error.message) + '</textarea></div>'
                        );
                    }
                    resetTxForm();
                });
                $('#send-cancel').addClass('d-none');
                $('#send-confirm').addClass('d-none');
                $('#send-close-footer').removeClass('d-none disabled');
            }).catch(function() {
                showSendError(messages.error['bad-utxo']);
            });
        };
        if (globalData.utxos.length > 0) {
            doSend(globalData.utxos);
        } else {
            fetch(getBackend() + '/unspent/' + address + '?confirmed=true')
            .then(function(r) { return r.json(); })
            .then(function(data) {
                var utxos = (data && data.error === null) ? data.result : [];
                var h     = globalData.height;
                utxos.forEach(function(u) {
                    u.mature     = isUtxoMature(u, h);
                    u.blocksLeft = blocksToMature(u, h);
                });
                globalData.utxos = utxos;
                doSend(utxos);
            })
            .catch(function() { showSendError(messages.error['not-enough-utxo']); });
        }
    }
    function getScriptType(script) {
        if (script[0] == bitcoin.opcodes.OP_0 && script[1] == 20) return 'bech32'
        if (script[0] == bitcoin.opcodes.OP_HASH160 && script[1] == 20) return 'segwit'
        if (script[0] == bitcoin.opcodes.OP_DUP && script[1] == bitcoin.opcodes.OP_HASH160 && script[2] == 20) return 'legacy'
        return undefined
    }
    function getP2SHScript(redeem) {
        return bitcoin.payments.p2sh({ 'redeem': redeem, 'network': getConfig()['network'] })
    }
    function getP2WPKHScript(pubkey) {
        return bitcoin.payments.p2wpkh({ 'pubkey': pubkey, 'network': getConfig()['network'] })
    }
    function validateAddress(address) {
        var network = getConfig()['network']
        try { bitcoin.address.fromBase58Check(address, network); return true } catch(e) {}
        try { bitcoin.address.fromBech32(address, network); return true } catch(e) {}
        return false
    }
    function stopStream() {
        scanSession += 1;
        if (scanRafId !== null) {
            cancelAnimationFrame(scanRafId);
            scanRafId = null;
        }
        if (scanVideo) {
            try { scanVideo.pause(); } catch(e) {}
            try { scanVideo.srcObject = null; } catch(e) {}
            scanVideo = null;
        }
        if (stream != null) {
            try { stream.getTracks().forEach(function(t) { t.stop() }) } catch(e) {}
            stream = null;
        }
        var canvasElement = document.getElementById('scan-canvas');
        if (canvasElement) {
            try {
                var canvas = canvasElement.getContext('2d');
                if (canvas) canvas.clearRect(0, 0, canvasElement.width || 0, canvasElement.height || 0);
            } catch(e) {}
            canvasElement.hidden = true;
            canvasElement.width = 0;
            canvasElement.height = 0;
        }
    }
    function startStream() {
        var canvasElement = document.getElementById('scan-canvas')
        var canvas = canvasElement.getContext('2d')
        var video  = document.createElement('video')
        var session = ++scanSession
        canvasElement.hidden = true
        $('#loading-message').text(getText('webcam-message')).removeClass('d-none')
        stopStream()
        scanSession = session
        scanVideo = video
        navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }).then(function(gstream) {
            if (session !== scanSession) {
                try { gstream.getTracks().forEach(function(t) { t.stop() }) } catch(e) {}
                return
            }
            stream = gstream
            scanVideo = video
            video.srcObject = stream
            video.setAttribute('playsinline', true)
            video.play()
            scanRafId = requestAnimationFrame(tick)
        }).catch(function() {
            if (session !== scanSession) return
            stopStream()
            $('#loading-message').text(getText('webcam-message')).removeClass('d-none')
            showMessage(getText('webcam-message'))
        })
        function tick() {
            if (session !== scanSession) return
            $('#loading-message').text(getText('webcam-loading'))
            var stop = false
            if (video.readyState === video.HAVE_ENOUGH_DATA) {
                $('#loading-message').addClass('d-none')
                canvasElement.hidden = false
                canvasElement.height = video.videoHeight
                canvasElement.width  = video.videoWidth
                canvas.drawImage(video, 0, 0, canvasElement.width, canvasElement.height)
                var imageData = canvas.getImageData(0, 0, canvasElement.width, canvasElement.height)
                var code = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'dontInvert' })
                if (code) {
                    var address = code.data
                    if (address.startsWith(getConfig()['uri'])) address = address.replace(getConfig()['uri'], '')
                    if (validateAddress(address)) {
                        if ($('#send-outputs input[name="send-address"]').last().val() != '') $('#add-output').click()
                        $('#send-outputs input[name="send-address"]').last().val(address)
                        showMessage(messages.misc.outputAdded(address))
                        stop = true
                    }
                }
            }
            if (!stop) {
                scanRafId = requestAnimationFrame(tick)
            } else {
                $('#scan-modal').modal('hide'); stopStream()
            }
        }
    }
    function showScanModal() {
        $('#scan-modal').modal('toggle')
        startStream()
    }
    function resetTxForm() {
        $('.send-additional-output').remove()
        $('#wallet-send input').val('')
        $('#wallet-send .wallet-balance').removeClass('text-danger')
        $('#send-fee, #send-outputs [name="send-ammount"]').removeClass('is-invalid')
        globalData.resetTx()
        validateSendForm()
    }
    function parseAmountSats(str) {
        var decimals = getConfig()['decimals']
        str = String(str == null ? '' : str).trim()
        if (str === '' || str === '.') return null
        if (!/^\d+\.?\d*$/.test(str)) return null
        var parts    = str.split('.')
        var intPart  = parts[0] || '0'
        var fracPart = (parts[1] || '').slice(0, decimals)
        while (fracPart.length < decimals) fracPart += '0'
        var sats = parseInt(intPart, 10) * Math.pow(10, decimals) + parseInt(fracPart || '0', 10)
        return Math.round(sats)
    }
    function filterAmountStr(val, decimals) {
        val = val.replace(/[^\d.]/g, '')
        var dotIdx = val.indexOf('.')
        if (decimals === 0) {
            val = val.replace(/\./g, '')
        } else if (dotIdx >= 0) {
            var before = val.slice(0, dotIdx + 1)
            var after  = val.slice(dotIdx + 1).replace(/\./g, '').slice(0, decimals)
            val = before + after
        }
        return val
    }
    function validateSendForm() {
        if (globalData.status !== 'unlocked') {
            $('#send-tx').prop('disabled', true)
            return
        }
        var feeStr     = $('#send-fee').val() !== '' ? $('#send-fee').val() : String(globalData.rfee)
        var feeSats    = parseAmountSats(feeStr)
        var minFeeSats = parseAmountSats(String(getConfig()['fee']))
        var outputsSats = 0
        var allFilled   = true
        var allAmtOk    = true
        $.each($('#send-outputs .send-outputs-item'), function(_, item) {
            var address = $('[name="send-address"]', item).val().trim()
            var amtStr  = $('[name="send-ammount"]', item).val().trim()
            var amtSats = parseAmountSats(amtStr)
            if (!address || !amtStr) allFilled = false
            if (!amtSats || amtSats <= 0) allAmtOk = false
            if (amtSats && amtSats > 0) outputsSats += amtSats
        })
        var feeOk     = feeSats !== null && feeSats > 0 && feeSats >= (minFeeSats || 0)
        var totalSats = outputsSats + (feeSats || 0)
        var spendableSats
        if (globalData.coinControl && globalData.selectedUtxos && globalData.selectedUtxos.size > 0) {
            spendableSats = 0
            globalData.utxos.forEach(function(u) {
                if (globalData.selectedUtxos.has(u.txid + ':' + u.index) && u.mature)
                    spendableSats += u.value
            })
        } else {
            spendableSats = globalData.balance - globalData.immatureBalance
        }
        var overLimit = totalSats > spendableSats && totalSats > 0
        var canSend   = allFilled && allAmtOk && feeOk && !overLimit && totalSats > 0
        $('#send-tx').prop('disabled', !canSend)
        $('#wallet-send .wallet-balance').toggleClass('text-danger', overLimit)
        var feeTyped = $('#send-fee').val() !== ''
        $('#send-fee').toggleClass('is-invalid', feeTyped && (!feeOk || overLimit))
        $('#send-outputs [name="send-ammount"]').each(function() {
            var amtSats = parseAmountSats($(this).val())
            var typed   = $(this).val() !== ''
            $(this).toggleClass('is-invalid', typed && (!amtSats || amtSats <= 0 || overLimit))
        })
    }
    // ─────────────────────────────────────────────────────────────────────
    $(document).ready(function() {
        initLang()
        $(document).on('click', '.theme-option', function(e) {
            e.preventDefault();
            var theme = $(this).data('theme');
            if (theme) setTheme(theme);
        });
        var _t; try { _t = localStorage.getItem('bte_cfg_theme') } catch(e) {}
        applyTheme(_t || 'auto')
        ;['click', 'keydown', 'touchstart', 'mousemove'].forEach(function(evt) {
            document.addEventListener(evt, function() { _resetAutoLock() }, { passive: true, capture: false })
        })
        $('#wallet-version').text(walletVersion)
        $('#wallet-backend input').val(getBackend())
        $('#address-type-select select').val(getAddressType())
        routePage()
        updateSavedWalletUI()
        $('#pin-confirm').click(function() {
            var pin = $('#pin-input').val()
            if (_pinResolve) {
                if (_pinValidator) {
                    var err = _pinValidator(pin)
                    if (err) {
                        $('#pin-error').text(err).removeClass('d-none')
                        $('#pin-input').focus()
                        return
                    }
                }
                $('#pin-error').addClass('d-none')
                var pinValue = pin
                $('#pin-input').val('')
                $('#pin-modal').modal('hide')
                var resolve = _pinResolve
                _pinResolve   = null
                _pinValidator = null
                resolve(pinValue)
            }
        })
        $('#pin-cancel').click(function() {
            $('#pin-input').val('')
            if (_pinResolve) { _pinResolve(null); _pinResolve = null; _pinValidator = null }
        })
        $('#pin-input').on('keydown', function(e) {
            if (e.key === 'Enter') $('#pin-confirm').click()
        })
        async function doPinLogin() {
            var pin = $('#pin-login-input').val();
            if (!pin) {
                $('#pin-login-error').text(getText('pin-login-error')).removeClass('d-none');
                return;
            }
            $('#pin-login-btn').prop('disabled', true).text(getText('loading'));
            try {
                var walletData = await loadWallet(pin);
                $('#pin-login-btn').prop('disabled', false).text(getText('pin-login-btn'));
                if (!walletData) {
                    $('#pin-login-error').text(getText('pin-login-error')).removeClass('d-none');
                    $('#pin-login-input').val('').focus();
                    pin = '';
                    return;
                }
                $('#pin-login-error').addClass('d-none');
                $('#pin-login-input').val('');

                var privBytes = new Uint8Array(bitcoin.Buffer.from(walletData.privHex, 'hex'));
                Keystore.setKeyPair(
                    bitcoin.ECPair.fromPrivateKey(bitcoin.Buffer.from(privBytes), { network: getConfig()['network'] })
                );
                privBytes.fill(0);
                walletData.privHex = '';
                globalData.pubKeyHex = walletData.pubkey;
                globalData.pubKey    = new Uint8Array(bitcoin.Buffer.from(walletData.pubkey, 'hex'));
                pin = '';
                openWallet(false);
            } catch (e) {
                $('#pin-login-btn').prop('disabled', false).text(getText('pin-login-btn'));
                $('#pin-login-error').text(getText('pin-login-error')).removeClass('d-none');
                pin = '';
            }
        }
        $('#pin-login-btn').click(doPinLogin)
        $('#pin-login-input').on('keydown', function(e) { if (e.key === 'Enter') doPinLogin() })
        $('#pin-login-forget').click(function(e) {
            e.preventDefault()
            forgetSavedWallet()
            showMessage(getText('wallet-deleted'))
        })
        $('#settings-forget-wallet').click(function() {
            forgetSavedWallet()
            showMessage(getText('wallet-deleted'))
        })
        $('.tab-link').click(function(e) {
            var tabFamily = $(this).data('tab-family')
            var tabName   = $(this).data('tab-name')
            if (tabFamily === 'wallet-block' && tabName !== 'wallet-keys') {
                clearPrivKeyInput();
                $('#wallet-privkey-copy-btn').addClass('d-none')
                $('#toggle-wallet-privkey').text(getText('show'))
            }
            $('#' + tabFamily + ' .tab-item').addClass('d-none')
            $('#' + tabFamily + ' .card-header .card-header-tabs .nav-link').removeClass('active')
            $('#' + tabFamily + ' [data-tab=' + tabName + ']').removeClass('d-none')
            $(this).addClass('active')
            if (tabName === 'wallet-history') updateHistory()
            if (tabName === 'wallet-settings') {
                $('#address-type-select select').val(getAddressType())
                $('#wallet-backend input').val(getBackend())
                if (hasSavedWallet()) {
                    $('#forget-wallet-section').removeClass('d-none')
                } else {
                    $('#forget-wallet-section').addClass('d-none')
                }
            }
            e.preventDefault()
        })
        $(window).on('hashchange', routePage)
        if (window.location.hash) $(window).trigger('hashchange')
        $('#send-tx').click(function() {
            var error      = false
            var decimals   = getConfig()['decimals']
            var feeStr     = $('#send-fee').val() !== '' ? $('#send-fee').val() : String(globalData.rfee)
            var feeSats    = parseAmountSats(feeStr)
            var minFeeSats = parseAmountSats(String(getConfig()['fee']))
            if (feeSats === null || feeSats <= 0) {
                showSendError(messages.error['not-valid-fee']); error = true
            } else if (feeSats < minFeeSats) {
                showSendError(messages.error['small-fee']); error = true
            }
            var outputsSats = 0
            $.each($('#send-outputs .send-outputs-item'), function(key, item) {
                var address = $('[name="send-address"]', item).val().trim()
                var amtStr  = $('[name="send-ammount"]', item).val()
                var amtSats = parseAmountSats(amtStr)
                if (amtSats === null || amtSats <= 0) {
                    showSendError(messages.error['not-valid-amount']); error = true
                }
                if (!validateAddress(address)) {
                    showSendError(messages.error['not-valid-address']); error = true
                }
                if (amtSats !== null) outputsSats += amtSats
            })
            var totalSats = outputsSats + (feeSats || 0)
            var spendableSats
            if (globalData.coinControl && globalData.selectedUtxos && globalData.selectedUtxos.size > 0) {
                spendableSats = 0
                globalData.utxos.forEach(function(u) {
                    if (globalData.selectedUtxos.has(u.txid + ':' + u.index) && u.mature) {
                        spendableSats += u.value
                    }
                })
            } else {
                spendableSats = globalData.balance - globalData.immatureBalance
            }
            if (!error) {
                if (totalSats <= spendableSats) {
                    showConfirmation(amountFormat(totalSats), totalSats, feeSats, outputsSats)
                } else {
                    showSendError(messages.error['not-enough-funds'])
                }
            }
        })
        $('#send-fee').on('input', function() {
            var cur = filterAmountStr($(this).val(), getConfig()['decimals'])
            if (cur !== $(this).val()) $(this).val(cur)
            validateSendForm()
        })
        $('#send-outputs').on('input', '[name="send-ammount"]', function() {
            var cur = filterAmountStr($(this).val(), getConfig()['decimals'])
            if (cur !== $(this).val()) $(this).val(cur)
            validateSendForm()
        })
        $('#send-outputs').on('input', '[name="send-address"]', function() {
            validateSendForm()
        })
        $(document).on('paste', '#send-fee, [name="send-ammount"]', function() {
            var self = this
            setTimeout(function() {
                var cur = filterAmountStr($(self).val(), getConfig()['decimals'])
                if (cur !== $(self).val()) $(self).val(cur)
                validateSendForm()
            }, 0)
        })
        // ─────────────────────────────────────────────────────────────────────
        $('#open-key-form').submit(function(e) {
            var wif = $('#passphrase').val().trim();
            if ([51, 52].includes(wif.length)) {
                try {
                    Keystore.setKeyPair(bitcoin.ECPair.fromWIF(wif, getConfig()['network']));
                    $('#passphrase').val('');
                    openWallet(true);
                } catch(err) {
                    showMessage(messages.error['bad-priv-key']);
                } finally {
                    wif = '';
                }
            } else {
                showMessage(messages.error['bad-priv-key']);
                wif = '';
            }
            e.preventDefault();
        });
        $('#open-regular-form').submit(function(e) {
            var identity    = $('#open-email').val().trim();
            var pass        = $('#open-password').val();
            var passConfirm = $('#open-password-confirm').val();
            if (identity.length >= 3) {
                if (pass.length >= 10) {
                    if (pass == passConfirm) {
                        var s = identity.toLowerCase();
                        s += '|' + pass + '|';
                        s += s.length + '|!@' + ((pass.length * 7) + identity.length) * 7;
                        var regchars   = (pass.match(/[a-z]+/g)) ? pass.match(/[a-z]+/g).length   : 1;
                        var regupchars = (pass.match(/[A-Z]+/g)) ? pass.match(/[A-Z]+/g).length   : 1;
                        var regnums    = (pass.match(/[0-9]+/g)) ? pass.match(/[0-9]+/g).length   : 1;
                        s += ((regnums + regchars) + regupchars) * pass.length + '3571';
                        s += (s + '' + s);
                        for (var i = 0; i <= 50; i++) s = sha256.update(s).hex();
                        var privBytes = new Uint8Array(sha256.update(s).array());
                        s = '';
                        $('#open-email').val('');
                        $('#open-password').val('');
                        $('#open-password-confirm').val('');
                        Keystore.setKeyPair(bitcoin.ECPair.fromPrivateKey(
                            bitcoin.Buffer.from(privBytes),
                            { 'network': getConfig()['network'] }
                        ));
                        privBytes.fill(0);
                        pass = '';
                        passConfirm = '';
                        openWallet(true);
                    } else { showMessage(messages.error['pass-not-match']); pass = ''; passConfirm = ''; }
                } else { showMessage(messages.error['pass-too-short']); pass = ''; passConfirm = ''; }
            } else { showMessage(getText('identity-too-short')); pass = ''; passConfirm = ''; }
            e.preventDefault();
        });
        $('#send-confirm').click(function(e) { sendTransaction(); e.preventDefault() })
        $('#toggle-wallet-privkey').click(function() {
            if ($(this).text() == getText('show')) {
                if (Keystore.isUnlocked()) {
                    revealPrivKeyInput(Keystore.getWIF());
                    $('#wallet-privkey-copy-btn').removeClass('d-none');
                    $(this).text(getText('hide'));
                }
            } else {
                clearPrivKeyInput();
                $('#wallet-privkey-copy-btn').addClass('d-none');
                $(this).text(getText('show'));
            }
        });
        $('#wallet-privkey-copy-btn').click(function() {
            if (Keystore.isUnlocked()) {
                copyToClipboard(Keystore.getWIF(), $(this));
            }
        });
        $('#add-output').click(function(e) {
            $('#send-outputs').append(
                '<div class="send-additional-output send-outputs-item input-group mb-2">' +
                '<input name="send-address" class="form-control" placeholder="' + getText('enter-address') + '" type="text">' +
                '<input name="send-ammount" class="form-control" placeholder="' + getText('amount') + '" type="text">' +
                '<button class="btn btn-outline-danger remove-additional-output" type="button"><span class="fa-solid fa-minus"></span></button>' +
                '</div>'
            )
            $('.remove-additional-output').off('click').on('click', function(e) {
                $(this).closest('.send-additional-output').remove()
                validateSendForm()
                e.preventDefault()
            })
            validateSendForm()
            e.preventDefault()
        })
        $('#send-reset').click(function(e) { resetTxForm(); e.preventDefault() })
        $('#send-qr').click(function(e)    { showScanModal(); e.preventDefault() })
        $('#footer-close').click(function(e) { closeWallet(); e.preventDefault() })
        $('#coin-control-toggle').click(function(e) {
            $('#coin-control-panel').toggleClass('d-none')
            var open = !$('#coin-control-panel').hasClass('d-none')
            $('#coin-control-toggle-text').text(open ? getText('coin-control') + ' ▲' : getText('coin-control'))
            if (open) renderCoinControl()
            e.preventDefault()
        })
        $(document).on('change', '#coin-control-enable', function() {
            globalData.coinControl = $(this).is(':checked')
            if (globalData.coinControl) {
                globalData.selectedUtxos = new Set()
                globalData.utxos.forEach(function(u) {
                    if (u.mature) globalData.selectedUtxos.add(u.txid + ':' + u.index)
                })
            } else {
                globalData.selectedUtxos = null
            }
            renderCoinControl()
            validateSendForm()
        })
        $('#coin-control-select-all').click(function(e) {
            if (!globalData.coinControl) return e.preventDefault()
            globalData.selectedUtxos = new Set()
            globalData.utxos.forEach(function(u) {
                if (u.mature) globalData.selectedUtxos.add(u.txid + ':' + u.index)
            })
            renderCoinControl()
            validateSendForm()
            e.preventDefault()
        })
        $(document).on('change', '.cc-utxo-check', function() {
            if (!globalData.coinControl || !globalData.selectedUtxos) return
            var key = $(this).data('key')
            if ($(this).is(':checked')) globalData.selectedUtxos.add(key)
            else globalData.selectedUtxos.delete(key)
            _updateCoinControlInfo()
            validateSendForm()
        })
        $('#footer-broadcast').click(function() {
            var rawtx = $('#transaction-broadcast-raw')
            transactionBroadcast(rawtx.val()).then(function(data) {
                if (data.error == null) {
                    showMessage(messages.tx['success'] + '<a href="' + escHtml(blockExplorer.tx(data.result)) + '" target="_blank" rel="noopener noreferrer">' + escHtml(data.result) + '</a>')
                } else {
                    showMessage(messages.error['broadcast-failed'])
                }
            })
            rawtx.val('')
        })
        $('#address-type-select select').on('change', function() {
            var newType = $(this).val();
            switchAddressType(newType);
            showMessage(messages.settings.typeSwitched(newType));
            if (!Keystore.isUnlocked()) return;
            if (globalData.address) clearUtxoCache(globalData.address);
            globalData.utxos = [];
            globalData.coinControl = false;
            globalData.selectedUtxos = null;
            globalData.immatureBalance = 0;
            globalData._lastRendered = { balance: -1, immature: -1, utxoFingerprint: '' };
            globalData.address        = Keystore.deriveAddress(newType, globalData.pubKey);
            globalData.scriptHex      = Keystore.getScriptHex(newType, globalData.pubKey);
            globalData.allScriptHexes = Keystore.getAllScriptHexes(globalData.pubKey);
            globalData.allAddresses   = Keystore.getAllAddresses(globalData.pubKey);
            if (_ws && _wsActive) {
                _ws.emit('subscribe', { address: globalData.address });
            }
            $('#wallet-address').text(globalData.address);
            showQrAddress(getConfig()['uri'] + globalData.address);
            $('#wallet-keys-pubkey input').val(globalData.pubKeyHex);
            clearPrivKeyInput();
            $('#wallet-privkey-copy-btn').addClass('d-none');
            $('#toggle-wallet-privkey').text(getText('show'));
            var redeem = '';
            if (newType !== 'legacy') {
                redeem = '0014' + bitcoin.Buffer.from(
                    bitcoin.payments.p2wpkh({ pubkey: globalData.pubKey, network: getConfig()['network'] }).hash
                ).toString('hex');
            }
            $('#wallet-keys-script input').val(redeem);
            if (newType === 'legacy') {
                $('#wallet-keys-script').addClass('d-none');
            } else {
                $('#wallet-keys-script').removeClass('d-none');
            }
            setHomeTitle();
        });
        $('#wallet-backend button').click(function() {
            switchBackend($('#wallet-backend input').val())
        })
        $(document).on('click', '.lang-switch-item', function(e) {
            e.preventDefault();
            var lang = $(this).data('lang');
            try { localStorage.setItem('bte_cfg_language', lang); } catch(e) {}
            initLang();
            var _ct; try { _ct = localStorage.getItem('bte_cfg_theme'); } catch(e) {}
            applyTheme(_ct || 'auto');
            if (Keystore.isUnlocked()) {
                setHomeTitle();
                renderHistory(loadHistory());
                if (!$('#coin-control-panel').hasClass('d-none')) renderCoinControl();
            }
        });
        estimateFee().then(function(data) {
            if (data.error == null) globalData.rfee = amountFormat(data.result.feerate)
            else globalData.rfee = getConfig()['fee']
        })
        $('#scan-modal').on('hide.bs.modal', function() { stopStream() })
        $('#copy-address-btn').click(function() {
            if (globalData.address) copyToClipboard(globalData.address, $(this))
        })
        function seedRenderGrid(words, containerId) {
            var $g = $(containerId).empty()
            words.forEach(function(w, i) {
                $g.append(
                    '<div class="border rounded px-1 py-1 text-center">' +
                    '<span class="text-muted d-block seed-word-num-label">' + (i + 1) + '</span>' +
                    '<strong class="seed-word-text">' + escHtml(w) + '</strong></div>'
                )
            })
        }
        $('#seed-btn-create').click(function() {
            $('#seed-entry').addClass('d-none')
            $('#seed-create').removeClass('d-none')
            _seedDoGenerate()
        })
        $('#seed-btn-restore').click(function() {
            $('#seed-entry').addClass('d-none')
            $('#seed-restore').removeClass('d-none')
        })
        $('#seed-create-cancel1, #seed-create-cancel2, #seed-restore-cancel').click(function(e) {
            e.preventDefault()
            seedReset()
        })
        $(document).on('click', '.seed-wlen-btn', function() {
            $('.seed-wlen-btn').removeClass('active')
            $(this).addClass('active')
            _seedState.strength = parseInt($(this).data('len'), 10)
            _seedDoGenerate()
        })
        function _seedDoGenerate() {
            if (typeof bip39Bundle === 'undefined') { alert('bip39-bundle.min.js not loaded'); return }
            _seedState.mnemonic = bip39Bundle.generateMnemonic(_seedState.strength)
            seedRenderGrid(_seedState.mnemonic.split(' '), '#seed-word-grid')
        }
        $('#seed-btn-print').click(function() {
            seedExportPNG(_seedState.mnemonic, getText)
        })
        $('#seed-btn-copy').click(function() {
            if (_seedState.mnemonic) copyToClipboard(_seedState.mnemonic, $(this))
        })
        $('#seed-btn-to-verify').click(function() {
            if (!_seedState.mnemonic) return
            var words = _seedState.mnemonic.split(' ')
            var len = words.length
            function rnd(lo, hi) {
                var buf = new Uint32Array(1)
                crypto.getRandomValues(buf)
                return lo + (buf[0] % (hi - lo + 1))
            }
            var third = Math.floor(len / 3)
            var pos = [rnd(0, third - 1), rnd(third, third * 2 - 1), rnd(third * 2, len - 1)]
            _seedState.verifyPositions = pos
            var $fields = $('#seed-verify-fields').empty()
            pos.forEach(function(p) {
                $fields.append(
                    '<div class="input-group input-group-sm mb-2">' +
                    '<span class="input-group-text seed-verify-num">' + getText('seed-word-num') + ' ' + (p + 1) + '</span>' +
                    '<input type="text" class="form-control font-monospace seed-verify-word" data-pos="' + p + '" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">' +
                    '</div>'
                )
            })
            $('#seed-verify-error').addClass('d-none')
            $('#seed-create-step1').addClass('d-none')
            $('#seed-create-step2').removeClass('d-none')
            setTimeout(function() { $('.seed-verify-word').first().focus() }, 100)
        })
        $('#seed-verify-back').click(function() {
            $('#seed-create-step2').addClass('d-none')
            $('#seed-create-step1').removeClass('d-none')
        })
        $('#seed-verify-confirm').click(function() {
            var words = _seedState.mnemonic.split(' ');
            var ok = true;
            $('.seed-verify-word').each(function() {
                var pos = parseInt($(this).data('pos'), 10);
                var entered = $(this).val().trim().toLowerCase();
                if (entered !== words[pos]) ok = false;
            });
            if (!ok) {
                $('#seed-verify-error').removeClass('d-none');
                return;
            }
            $('#seed-verify-error').addClass('d-none');
            try {
                var privBytes = bip39Bundle.mnemonicToPrivKey(_seedState.mnemonic, "m/84'/0'/0'/0/0");
                var keyPair = bitcoin.ECPair.fromPrivateKey(bitcoin.Buffer.from(privBytes));
                privBytes.fill(0);
                Keystore.setKeyPair(keyPair);
                openWallet(true, _seedState.mnemonic);
                _seedState.mnemonic = '';
            } catch(err) {
                alert('Key derivation error: ' + err.message);
            }
        });
        $('#restore-wordcount').change(function() {
            var cnt = parseInt($(this).val(), 10)
            var words = $('#restore-input').val().trim().split(/\s+/).filter(Boolean)
            if (cnt === 12 && words.length > 12) {
                $('#restore-input').val(words.slice(0, 12).join(' '))
            }
        })
        $('#seed-restore-btn').click(async function() {
            if (typeof bip39Bundle === 'undefined') { alert('bip39-bundle.min.js not loaded'); return; }
            $('#restore-word-error').addClass('d-none');
            var raw = $('#restore-input').val().trim().toLowerCase().replace(/\s+/g, ' ');
            var words = raw.split(' ');
            var expectedLen = parseInt($('#restore-wordcount').val(), 10);
            if (words.length !== expectedLen) {
                $('#restore-word-error').text(getText('seed-count-mismatch').replace('{n}', expectedLen).replace('{m}', words.length)).removeClass('d-none');
                return;
            }
            if (!bip39Bundle.validateMnemonic(raw)) {
                $('#restore-word-error').text(getText('seed-invalid-phrase')).removeClass('d-none');
                return;
            }
            var path = ($('#restore-path').val().trim() || "m/84'/0'/0'/0/0");
            try {
                var privBytes = bip39Bundle.mnemonicToPrivKey(raw, path);
                var keyPair = bitcoin.ECPair.fromPrivateKey(bitcoin.Buffer.from(privBytes));
                privBytes.fill(0);
                Keystore.setKeyPair(keyPair);
                await openWallet(true, raw);
                $('#restore-input').val('');
                _seedState.mnemonic = '';
            } catch(err) {
                $('#restore-word-error').text(getText('seed-deriv-error') + ' ' + err.message).removeClass('d-none');
            }
        });
        $('#btn-show-seed').click(async function() {
            if (!hasSeedBackup()) return;
            var seedData = await new Promise(function(resolve) {
                $('#pin-modal-title').text(getText('seed-pin-modal-title'));
                $('#pin-modal-desc').text(getText('seed-pin-modal-desc'));
                $('#pin-input').val('');
                $('#pin-error').addClass('d-none');
                var modal = new bootstrap.Modal(document.getElementById('pin-modal'), { keyboard: false });
                modal.show();
                function onConfirm() {
                    var p = $('#pin-input').val();
                    loadEncrypted(STORAGE_KEY_SEED, p).then(function(mnemonic) {
                        if (!mnemonic) {
                            $('#pin-error').removeClass('d-none');
                            return;
                        }
                        var result = { mnemonic: mnemonic };
                        mnemonic = '';
                        modal.hide();
                        $('#pin-confirm').off('click', onConfirm);
                        resolve(result);
                    });
                }
                function onCancel() {
                    $('#pin-confirm').off('click', onConfirm);
                    $('#pin-cancel').off('click', onCancel);
                    modal.hide();
                    resolve(null);
                }
                $('#pin-confirm').off('click').on('click', onConfirm);
                $('#pin-cancel').off('click').on('click', onCancel);
            });
            if (!seedData) return;
            var words = seedData.mnemonic.split(' ');
            seedData.mnemonic = '';
            seedData = null;
            seedRenderGrid(words, '#wallet-seed-grid');
            words.fill('');
            words = null;
            $('#wallet-seed-hidden').addClass('d-none');
            $('#wallet-seed-revealed').removeClass('d-none');
            setTimeout(_hideSeedReveal, 60000);
        });
        $('#btn-hide-seed').click(_hideSeedReveal)
        $('#btn-copy-seed').click(function() {
            var mnemonic = []
            $('#wallet-seed-grid strong').each(function() { mnemonic.push($(this).text()) })
            try {
                if (mnemonic.length) copyToClipboard(mnemonic.join(' '), $(this))
            } finally {
                mnemonic.fill('')
                mnemonic.length = 0
                mnemonic = null
            }
        })
        $('.tab-link').on('click', function() {
            if ($(this).data('tab-family') === 'wallet-block' && $(this).data('tab-name') !== 'wallet-keys') {
                _hideSeedReveal()
            }
        })
    })
    var _ws       = null;
    var _wsActive = false;
    function wsConnect() {
        if (typeof io === 'undefined') return;
        if (!globalData.address)       return;
        if (_ws && _wsActive)          return;
        wsDisconnect();
        var backend = getBackend();
        try {
            _ws = io(backend, {
                path:                 '/socket.io',
                transports:           ['websocket'],
                reconnectionDelay:    5000,
                reconnectionDelayMax: 30000,
                timeout:              10000
            });
        } catch(e) {
            return;
        }
        _ws.on('connect', function() {
            _wsActive = true;
            if (globalData.address) {
                _ws.emit('subscribe', { address: globalData.address });
            }
        });
        _ws.on('block', function(data) {
            if (globalData.status !== 'unlocked') return;
            if (!data || typeof data.height !== 'number') return;
            var prevHeight = globalData.height;
            globalData.height = data.height;
            if (globalData.utxos.length > 0) {
                var h = globalData.height;
                globalData.utxos.forEach(function(u) {
                    u.mature     = isUtxoMature(u, h);
                    u.blocksLeft = blocksToMature(u, h);
                });
                _applyUtxoData();
            }
            if (globalData.height !== prevHeight && globalData.address) {
                updateHistory();
            }
        });
        _ws.on('balance_changed', function(data) {
            if (globalData.status !== 'unlocked') return;
            if (data && typeof data.balance === 'number' && Array.isArray(data.utxos)) {
                var prevBalance = globalData.balance;
                globalData.balance = data.balance;
                if (typeof data.height === 'number') {
                    globalData.height = data.height;
                }
                var h = globalData.height;
                globalData.utxos = data.utxos.map(function(u) {
                    return Object.assign({}, u, {
                        mature:     isUtxoMature(u, h),
                        blocksLeft: blocksToMature(u, h)
                    });
                });
                saveUtxoCache(globalData.address, globalData.utxos, h);
                _applyUtxoData();
                if (globalData.balance !== prevBalance && globalData.address) {
                    updateHistory();
                }
            }
        });
        _ws.on('disconnect', function() {
            _wsActive = false;
        });
        _ws.on('connect_error', function() {
            _wsActive = false;
        });
    }
    function wsDisconnect() {
        if (_ws) {
            try { _ws.disconnect(); } catch(e) {}
            _ws       = null;
            _wsActive = false;
        }
    }
	window.setTheme = setTheme;
})();
