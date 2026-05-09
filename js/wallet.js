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
            var buf = bitcoin.Buffer.from(keyPair.privateKey);
            var hex = buf.toString('hex');
            buf.fill(0);
            return hex;
        }
        // BIP341 key-path signer.
        // Returns { signer, _rawD, _effectiveD, _tweakedD } — caller MUST wipe _* fields
        // in a finally-block regardless of success/failure.
        //
        // Algorithm (BIP341 §4.4):
        //   1. xOnlyPub  = pubkey[1..33]  (drop 0x02/0x03 prefix)
        //   2. tweak     = taggedHash('TapTweak', xOnlyPub)
        //   3. effectiveD = (y(P) is odd) ? privateNegate(d) : d   — lift to even-y point
        //   4. tweakedD  = privateAdd(effectiveD, tweak) mod n
        //   5. signer.publicKey = xOnlyPub  — matches tapInternalKey stored in PSBT input
        //   6. signer.signSchnorr(hash) signs with tweakedD  (BIP340 Schnorr)
        //
        // Source of public key: keyPair.publicKey (33-byte compressed, from Keystore closure).
        // The x-only form is always pubkey.slice(1) — prefix byte carries only parity info.
        function _makeTaprootSigner() {
            var ecc = bitcoin.ecc;
            if (!ecc || typeof ecc.privateAdd !== 'function' ||
                        typeof ecc.privateNegate !== 'function' ||
                        typeof ecc.signSchnorr !== 'function' ||
                        typeof ecc.xOnlyPointAddTweak !== 'function') {
                throw new Error('bitcoin.ecc unavailable — rebuild bundle (see BUILDBitcoinjs.md)');
            }

            // x-only internal key = drop parity prefix byte (32 bytes)
            var xOnlyPub = keyPair.publicKey.slice(1);

            // TapTweak = taggedHash('TapTweak', xOnlyPub)  — pure function, no key material
            var tweak = bitcoin.crypto.taggedHash('TapTweak', xOnlyPub);

            // Copies of sensitive material — zeroed in finally of every call-site
            var rawD      = new Uint8Array(keyPair.privateKey);  // copy, never a reference
            var effectiveD = null;
            var tweakedD   = null;

            try {
                // BIP341: parity of y(P) determines whether to negate before adding tweak.
                // Compressed pubkey prefix 0x03 = odd y  →  negate d.
                var oddY = (keyPair.publicKey[0] === 0x03);
                effectiveD = oddY ? ecc.privateNegate(rawD) : new Uint8Array(rawD);

                // tweakedD = (effectiveD + tweak) mod n
                tweakedD = ecc.privateAdd(effectiveD, tweak);
                if (!tweakedD) throw new Error('Taproot tweak produced an invalid private key');

                // Compute tweaked OUTPUT public key (32-byte x-only).
                // bitcoinjs-lib v7 PSBT signInput() calls tapKeyPubkeyValidator (bip371.ts)
                // which computes xOnlyPointAddTweak(tapInternalKey) and compares it to
                // signer.publicKey. If we pass the raw internal key here, the comparison
                // fails, signInput() skips signing, tapKeySig is never set, and
                // finalizeAllInputs() throws — which the caller's .catch shows as bad-utxo.
                var tweakedPubResult = ecc.xOnlyPointAddTweak(xOnlyPub, tweak);
                if (!tweakedPubResult) throw new Error('Taproot xOnlyPointAddTweak failed');
                var tweakedXOnly = tweakedPubResult.xOnlyPubkey;

                // Capture in local var so the closure cannot be confused by re-assignment
                var _td = tweakedD;

                var signer = {
                    // Must be the tweaked OUTPUT x-only key (32 bytes), NOT the internal key.
                    // v7 PSBT matches this against xOnlyPointAddTweak(tapInternalKey).
                    publicKey: tweakedXOnly,

                    // Called by psbt.signInput for taproot key-path inputs (BIP340 Schnorr).
                    signSchnorr: function(hash) {
                        return ecc.signSchnorr(hash, _td);
                    }
                };

                return { signer: signer, _rawD: rawD, _effectiveD: effectiveD, _tweakedD: tweakedD };
            } catch (e) {
                // Wipe on construction error before re-throwing
                if (rawD)      rawD.fill(0);
                if (effectiveD) effectiveD.fill(0);
                if (tweakedD)  tweakedD.fill(0);
                throw e;
            }
        }

        function signAllInputs(psbt) {
            if (!keyPair) throw new Error('Wallet locked');

            // Fast path: no taproot inputs — plain ECDSA, no extra key material needed.
            var hasTaproot = psbt.data.inputs.some(function(inp) {
                return inp.tapInternalKey && inp.tapInternalKey.length === 32;
            });
            if (!hasTaproot) {
                psbt.signAllInputs(keyPair);
                return;
            }

            // Taproot present: build tweaked signer once, wipe in finally no matter what.
            var tapMaterial = null;
            try {
                tapMaterial = _makeTaprootSigner();
                var tapSigner = tapMaterial.signer;

                psbt.data.inputs.forEach(function(inp, idx) {
                    if (inp.tapInternalKey && inp.tapInternalKey.length === 32) {
                        // Key-path spend: tweaked Schnorr signer
                        psbt.signInput(idx, tapSigner);
                    } else {
                        // Legacy / SegWit input in mixed transaction: plain ECDSA
                        psbt.signInput(idx, keyPair);
                    }
                });
            } finally {
                // Zero all intermediate private key copies regardless of success/failure.
                if (tapMaterial) {
                    if (tapMaterial._rawD)       tapMaterial._rawD.fill(0);
                    if (tapMaterial._effectiveD) tapMaterial._effectiveD.fill(0);
                    if (tapMaterial._tweakedD)   tapMaterial._tweakedD.fill(0);
                }
            }
        }
        function deriveAddress(type, pubKey) {
            if (!keyPair || !pubKey) return '';
            var network = getConfig()['network'];
            if (type === 'bech32') {
                return bitcoin.payments.p2wpkh({ pubkey: pubKey, network: network }).address;
            } else if (type === 'segwit') {
                var redeem = bitcoin.payments.p2wpkh({ pubkey: pubKey, network: network });
                return bitcoin.payments.p2sh({ redeem: redeem, network: network }).address;
            } else if (type === 'taproot') {
                var xOnlyPub = pubKey.length === 33 ? pubKey.slice(1) : pubKey;
                return bitcoin.payments.p2tr({ internalPubkey: xOnlyPub, network: network }).address;
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
            } else if (type === 'taproot') {
                var xOnlyPub = pubKey.length === 33 ? pubKey.slice(1) : pubKey;
                return bitcoin.Buffer.from(bitcoin.payments.p2tr({ internalPubkey: xOnlyPub, network: network }).output).toString('hex');
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
            try {
                var xOnlyPub = pubKey.length === 33 ? pubKey.slice(1) : pubKey;
                set.add(bitcoin.Buffer.from(bitcoin.payments.p2tr({ internalPubkey: xOnlyPub, network: network }).output).toString('hex').toLowerCase());
            } catch(e) {}
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
            try {
                var xOnlyPub = pubKey.length === 33 ? pubKey.slice(1) : pubKey;
                set.add(bitcoin.payments.p2tr({ internalPubkey: xOnlyPub, network: network }).address);
            } catch(e) {}
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
    var STORAGE_KEY_PATH = 'bte_wallet_path';
    // Passkey (WebAuthn PRF) duplicates — encrypted with PRF output instead of PIN
    // Passkey is considered ENABLED iff BOTH bte_pk_credential_id AND bte_wallet_privkey_pk exist.
    // No separate flag — presence of encrypted data IS the indicator (tamper-proof by design).
    var STORAGE_KEY_PUB_PK   = 'bte_wallet_pubkey_pk';
    var STORAGE_KEY_PRIV_PK  = 'bte_wallet_privkey_pk';
    var STORAGE_KEY_SEED_PK  = 'bte_wallet_seed_pk';
    var STORAGE_KEY_PK_ID    = 'bte_pk_credential_id';
    var DEFAULT_DERIV_PATH = "m/84'/738'/0'/0/0";
    function hasSeedBackup() {
        return localStorage.getItem(STORAGE_KEY_SEED) !== null;
    }
    function clearSeedState() {
        if (_seedState.words && _seedState.words.length) _seedState.words.fill('');
        _seedState.words = [];
        _seedState.enc = null;
        _seedState.tempKey = null;
        _seedState.verifyHashes = [];
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
    // ── Passkey helpers: encrypt / decrypt using raw 32-byte PRF key ────────────
    // No PBKDF2 needed — PRF output is already full-entropy.
    async function saveEncryptedWithKey(storageKey, plaintext, keyBytes) {
        var iv  = crypto.getRandomValues(new Uint8Array(12));
        var key = await crypto.subtle.importKey(
            'raw', keyBytes, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
        );
        var ct = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv: iv }, key, new TextEncoder().encode(plaintext)
        );
        localStorage.setItem(storageKey, JSON.stringify({
            iv:   Array.from(iv),
            data: Array.from(new Uint8Array(ct))
        }));
    }
    async function loadEncryptedWithKey(storageKey, keyBytes) {
        var raw = localStorage.getItem(storageKey);
        if (!raw) return null;
        var blob = JSON.parse(raw);
        var key  = await crypto.subtle.importKey(
            'raw', keyBytes, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
        );
        try {
            var pt     = await crypto.subtle.decrypt(
                { name: 'AES-GCM', iv: new Uint8Array(blob.iv) }, key, new Uint8Array(blob.data)
            );
            var view   = new Uint8Array(pt);
            var result = new TextDecoder().decode(pt);
            view.fill(0);
            return result;
        } catch(e) { return null; }
    }
    // ── Passkey state helpers ─────────────────────────────────────────────────
    function isPasskeyEnabled() {
        // Enabled iff BOTH credential ID and encrypted private key blob exist.
        // No separate flag — setting bte_pass_key='1' in devtools does nothing without the blobs.
        try {
            return localStorage.getItem(STORAGE_KEY_PK_ID)   !== null &&
                   localStorage.getItem(STORAGE_KEY_PRIV_PK) !== null;
        } catch(e) { return false; }
    }
    function hasPasskeyCredential() {
        return isPasskeyEnabled();
    }
    function hasSeedPkBackup() {
        try { return localStorage.getItem(STORAGE_KEY_SEED_PK) !== null; } catch(e) { return false; }
    }
    async function checkPasskeySupport() {
        if (!window.PublicKeyCredential) return false;
        return !!(navigator.credentials && navigator.credentials.create);
    }
    // PRF salt — deterministic string, same on every call
    var _PK_PRF_SALT = new TextEncoder().encode('bitweb-wallet-v1');
    // Convert rawId (ArrayBuffer) to base64 string for storage
    function _credIdToB64(rawId) {
        return btoa(String.fromCharCode.apply(null, new Uint8Array(rawId)));
    }
    function _b64ToCredId(b64) {
        return Uint8Array.from(atob(b64), function(c) { return c.charCodeAt(0); });
    }
    // ── Enable passkey ────────────────────────────────────────────────────────
    async function pkEnable() {
        // 1. Confirm identity with PIN and decrypt current keys in one shot
        var pin = await askPin(
            getText('pin-title-default') || 'Wallet PIN',
            (getText('passkey-confirm-pin') || 'Enter PIN to verify identity before setting up passkey'),
            null, false
        );
        if (pin === null) return;
        // Decrypt all stored keys in parallel — each blob is independent.
        var pkResults = await Promise.all([
            loadEncrypted(STORAGE_KEY_PRIV, pin),
            loadEncrypted(STORAGE_KEY_PUB,  pin),
            loadEncrypted(STORAGE_KEY_SEED, pin)
        ]);
        var privHex = pkResults[0], pubHex = pkResults[1], seedEntropyHex = pkResults[2];
        if (!privHex || !pubHex) {
            pin = null;
            showMessage(getText('pin-login-error') || 'Wrong PIN');
            return;
        }
        pin = null;
        // 2. Register a new passkey with PRF extension
        var challenge = crypto.getRandomValues(new Uint8Array(32));
        var userId    = crypto.getRandomValues(new Uint8Array(16));
        try {
            var credential = await navigator.credentials.create({
                publicKey: {
                    challenge: challenge,
                    rp:  {
                        name: getConfig()['title'] || 'Bitweb Wallet',
                        id:   window.location.hostname
                    },
                    user: {
                        id:          userId,
                        name:        'wallet',
                        displayName: 'Bitweb Wallet'
                    },
                    pubKeyCredParams: [
                        { type: 'public-key', alg: -7   },  // ES256
                        { type: 'public-key', alg: -257 }   // RS256
                    ],
                    authenticatorSelection: {
                        userVerification: 'required',
                        residentKey:      'preferred'
                    },
                    extensions: {
                        prf: { eval: { first: _PK_PRF_SALT } }
                    }
                }
            });
            var ext = credential.getClientExtensionResults();
            if (!ext.prf || !ext.prf.results || !ext.prf.results.first) {
                privHex = ''; pubHex = ''; seedEntropyHex = '';
                showMessage(getText('passkey-prf-unsupported') || 'This browser/device does not support the PRF extension required for passkey unlock. Use PIN instead.');
                return;
            }
            var prfBytes = new Uint8Array(ext.prf.results.first);
            // 3. Encrypt keys with PRF output
            await saveEncryptedWithKey(STORAGE_KEY_PRIV_PK, privHex, prfBytes);
            await saveEncryptedWithKey(STORAGE_KEY_PUB_PK,  pubHex,  prfBytes);
            if (seedEntropyHex) await saveEncryptedWithKey(STORAGE_KEY_SEED_PK, seedEntropyHex, prfBytes);
            prfBytes.fill(0);
            privHex = ''; pubHex = ''; seedEntropyHex = '';
            // 4. Store credential ID — presence of this + PRIV_PK is the "enabled" signal
            localStorage.setItem(STORAGE_KEY_PK_ID,   _credIdToB64(credential.rawId));
            updatePasskeyUI();
            showMessage(getText('passkey-enabled') || '🔐 Passkey enabled — you can now unlock with biometrics');
        } catch(e) {
            privHex = ''; pubHex = ''; seedEntropyHex = '';
            if (e.name === 'NotAllowedError') return;  // User cancelled — silent
            showMessage((getText('passkey-error') || 'Passkey error: ') + e.message);
        }
    }
    // ── Authenticate with passkey ──────────────────────────────────────────────
    function _isTransientPasskeyError(e) {
        if (!e || !e.message) return false;
        var m = e.message.toLowerCase();
        return m.indexOf('transient') !== -1 || m.indexOf('unknown') !== -1;
    }
    async function pkAuthenticate(_retriesLeft) {
        if (_retriesLeft === undefined) _retriesLeft = 2;
        var credIdStr = null;
        try { credIdStr = localStorage.getItem(STORAGE_KEY_PK_ID); } catch(e) {}
        if (!credIdStr) { showMessage(getText('passkey-not-setup') || 'Passkey not set up'); return; }
        var credIdBytes = _b64ToCredId(credIdStr);
        try {
            var assertion = await navigator.credentials.get({
                publicKey: {
                    challenge:         crypto.getRandomValues(new Uint8Array(32)),
                    rpId:              window.location.hostname,
                    allowCredentials:  [{ type: 'public-key', id: credIdBytes }],
                    userVerification:  'required',
                    extensions: {
                        prf: { eval: { first: _PK_PRF_SALT } }
                    }
                }
            });
            var ext = assertion.getClientExtensionResults();
            if (!ext.prf || !ext.prf.results || !ext.prf.results.first) {
                showMessage(getText('passkey-prf-unsupported') || 'PRF extension not available');
                return;
            }
            var prfBytes = new Uint8Array(ext.prf.results.first);
            var privHex  = await loadEncryptedWithKey(STORAGE_KEY_PRIV_PK, prfBytes);
            var pubHex   = await loadEncryptedWithKey(STORAGE_KEY_PUB_PK,  prfBytes);
            prfBytes.fill(0);
            if (!privHex || !pubHex) {
                showMessage(getText('passkey-decrypt-failed') || 'Passkey decryption failed — try PIN');
                return;
            }
            var privBytes = new Uint8Array(bitcoin.Buffer.from(privHex, 'hex'));
            Keystore.setKeyPair(
                bitcoin.ECPair.fromPrivateKey(bitcoin.Buffer.from(privBytes), { network: getConfig()['network'] })
            );
            privBytes.fill(0);
            globalData.pubKeyHex = pubHex;
            globalData.pubKey    = new Uint8Array(bitcoin.Buffer.from(pubHex, 'hex'));
            privHex = ''; pubHex = '';
            openWallet(false);
        } catch(e) {
            if (e.name === 'NotAllowedError') return;  // User cancelled — silent
            // Auto-retry on transient platform-authenticator errors (common in Chrome/Windows Hello)
            if (_retriesLeft > 0 && _isTransientPasskeyError(e)) {
                await new Promise(function(r) { setTimeout(r, 300); });
                return pkAuthenticate(_retriesLeft - 1);
            }
            showMessage((getText('passkey-error') || 'Passkey error: ') + e.message);
        }
    }
    // ── Shared action: wipe PK records ────────────────────────────────────────
    function _doPkDisable() {
        [STORAGE_KEY_PRIV_PK, STORAGE_KEY_PUB_PK, STORAGE_KEY_SEED_PK, STORAGE_KEY_PK_ID].forEach(function(k) {
            try { localStorage.removeItem(k); } catch(e) {}
        });
        updatePasskeyUI();
        showMessage(getText('passkey-disabled') || 'Passkey disabled');
    }
    // ── Disable passkey — accepts passkey OR PIN ───────────────────────────────
    async function pkDisable() {
        // Passkey callback: authenticate with passkey to prove identity, then disable
        async function onPasskeyChosen(_retriesLeft) {
            if (_retriesLeft === undefined) _retriesLeft = 2;
            var credIdStr = null;
            try { credIdStr = localStorage.getItem(STORAGE_KEY_PK_ID); } catch(e) {}
            if (!credIdStr) return;
            try {
                await navigator.credentials.get({
                    publicKey: {
                        challenge:         crypto.getRandomValues(new Uint8Array(32)),
                        rpId:              window.location.hostname,
                        allowCredentials:  [{ type: 'public-key', id: _b64ToCredId(credIdStr) }],
                        userVerification:  'required',
                        extensions:        { prf: { eval: { first: _PK_PRF_SALT } } }
                    }
                });
                _doPkDisable();
            } catch(e) {
                if (e.name === 'NotAllowedError') return;
                if (_retriesLeft > 0 && _isTransientPasskeyError(e)) {
                    await new Promise(function(r) { setTimeout(r, 300); });
                    return onPasskeyChosen(_retriesLeft - 1);
                }
                showMessage((getText('passkey-error') || 'Passkey error: ') + e.message);
            }
        }
        var pin = await askPin(
            getText('pin-title-default') || 'Wallet PIN',
            getText('passkey-disable-confirm') || 'Enter PIN (or use Passkey) to disable passkey',
            null, false,
            onPasskeyChosen  // shows "Use Passkey" button in modal
        );
        if (pin === null) return;  // cancelled OR passkey path (passkey path is self-contained)
        // PIN path
        var walletData = await loadWallet(pin);
        pin = null;
        if (!walletData) {
            showMessage(getText('pin-login-error') || 'Wrong PIN');
            return;
        }
        walletData = null;
        _doPkDisable();
    }
    // ── Update all passkey-related UI ─────────────────────────────────────────
    function updatePasskeyUI() {
        updatePasskeyLoginUI();
        updatePasskeySettingsUI();
    }
    function updatePasskeyLoginUI() {
        if (isPasskeyEnabled() && hasPasskeyCredential()) {
            $('#pk-login-wrapper').removeClass('d-none');
        } else {
            $('#pk-login-wrapper').addClass('d-none');
        }
    }
    function updatePasskeySettingsUI() {
        var $section = $('#passkey-settings-section');
        if (!$section.length) return;
        if (isPasskeyEnabled()) {
            $('#passkey-settings-status').text(getText('passkey-status-enabled') || '✅ Enabled — biometric unlock active');
            $('#passkey-settings-btn')
                .text(getText('passkey-disable-btn') || 'Disable Passkey')
                .removeClass('btn-outline-primary btn-success')
                .addClass('btn-outline-danger');
        } else {
            $('#passkey-settings-status').text(getText('passkey-status-disabled') || '🔒 Disabled — PIN only');
            $('#passkey-settings-btn')
                .text(getText('passkey-enable-btn') || '🔐 Enable Passkey')
                .removeClass('btn-outline-danger btn-success')
                .addClass('btn-outline-primary');
        }
        // Show/hide section only when wallet is open (settings are inside wallet-block)
        $section.removeClass('d-none');
    }
    // ─────────────────────────────────────────────────────────────────────────
    async function saveWalletWif(pin) {
        var pubkey  = globalData.pubKeyHex;
        var privHex = Keystore.getPrivKeyHex();
        // Encrypt both in parallel — independent blobs, each gets its own salt/iv.
        await Promise.all([
            saveEncrypted(STORAGE_KEY_PUB,  pubkey,  pin),
            saveEncrypted(STORAGE_KEY_PRIV, privHex, pin)
        ]);
        localStorage.removeItem(STORAGE_KEY_SEED);
        localStorage.removeItem(STORAGE_KEY_PATH);
        privHex = '';
    }
    async function saveWalletBip39(mnemonic, pin, path) {
        var pubkey     = globalData.pubKeyHex;
        var privHex    = Keystore.getPrivKeyHex();
        var entropyHex = _mnemonicToEntropyHex(mnemonic);
        mnemonic = '';
        // Encrypt all three in parallel — independent blobs.
        await Promise.all([
            saveEncrypted(STORAGE_KEY_PUB,  pubkey,     pin),
            saveEncrypted(STORAGE_KEY_PRIV, privHex,    pin),
            saveEncrypted(STORAGE_KEY_SEED, entropyHex, pin)
        ]);
        try { localStorage.setItem(STORAGE_KEY_PATH, path || DEFAULT_DERIV_PATH); } catch(e) {}
        privHex    = '';
        entropyHex = '';
    }
    async function loadWallet(pin) {
        // Decrypt both keys in parallel — each blob has its own salt, no dependency.
        var results = await Promise.all([
            loadEncrypted(STORAGE_KEY_PUB,  pin),
            loadEncrypted(STORAGE_KEY_PRIV, pin)
        ]);
        var pubHex = results[0], privHex = results[1];
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
            { name: 'PBKDF2', salt: salt, iterations: 300000, hash: 'SHA-256' },
            km,
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt', 'decrypt']
        )
    }
    // ── Entropy helpers — store seed as hex bytes, not mnemonic words ─────────
    // Converts mnemonic string → compact hex (e.g. "abandon ability..." → "0c1e3a...")
    // Caller must zero the mnemonic string reference after calling.
    function _mnemonicToEntropyHex(mnemonic) {
        var bytes = bip39Bundle.mnemonicToEntropy(mnemonic);
        var hex   = Array.from(bytes).map(function(b) {
            return b.toString(16).padStart(2, '0');
        }).join('');
        bytes.fill(0);
        return hex;
    }
    // Converts entropyHex back → mnemonic string for display or key derivation.
    // Caller must zero both entropyHex reference and returned mnemonic after use.
    function _entropyHexToMnemonic(entropyHex) {
        var bytes    = new Uint8Array(entropyHex.match(/../g).map(function(h) {
            return parseInt(h, 16);
        }));
        var mnemonic = bip39Bundle.entropyToMnemonic(bytes);
        bytes.fill(0);
        return mnemonic;
    }
    function hasSavedWallet() {
        return localStorage.getItem(STORAGE_KEY_PRIV) !== null;
    }
    function forgetSavedWallet() {
        _stopAutoLock();
        stopStream();
        wsDisconnect();
        [STORAGE_KEY_PUB, STORAGE_KEY_PRIV, STORAGE_KEY_SEED, STORAGE_KEY_PATH,
         STORAGE_KEY_PUB_PK, STORAGE_KEY_PRIV_PK, STORAGE_KEY_SEED_PK, STORAGE_KEY_PK_ID].forEach(function(k) {
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
        if (hasSavedWallet() && !Keystore.isUnlocked()) {
            $('#pin-login-block').removeClass('d-none');
            $('#open-block').addClass('d-none');
            $('#forget-wallet-section').removeClass('d-none');
        } else if (!hasSavedWallet()) {
            $('#pin-login-block').addClass('d-none');
            $('#open-block').removeClass('d-none');
            $('#forget-wallet-section').addClass('d-none');
        } else {
            $('#pin-login-block').addClass('d-none');
            $('#open-block').addClass('d-none');
        }
        updatePasskeyLoginUI();
    }
    function _revealSeed(entropyHex) {
        if (_revealedWords.length) _revealedWords.fill('');
        var mnemonic   = _entropyHexToMnemonic(entropyHex);
        entropyHex     = '';
        _revealedWords = mnemonic.split(' ');
        mnemonic       = '';
        seedRenderGrid(_revealedWords, '#wallet-seed-grid');
        $('#wallet-seed-hidden').addClass('d-none');
        $('#wallet-seed-revealed').removeClass('d-none');
        setTimeout(_hideSeedReveal, 60000);
    }
    // ─────────────────────────────────────────────────────────────────────────
    var _pinResolve          = null
    var _pinValidator        = null
    var _pinPasskeyCallback  = null   // set by askPin when a passkey option is provided
    // askPin — optional 5th param: async fn called when user clicks "Use Passkey" in modal.
    // When provided and isPasskeyEnabled(), shows the #pin-modal-pk-btn button.
    function askPin(title, desc, validator, mandatory, onPasskeyClick) {
        return new Promise(function(resolve) {
            _pinResolve          = resolve
            _pinValidator        = validator || null
            _pinPasskeyCallback  = null
            $('#pin-modal-title').text(title)
            $('#pin-modal-desc').text(desc)
            $('#pin-input').val('')
            $('#pin-error').addClass('d-none')
            if (mandatory) {
                $('#pin-cancel').addClass('d-none')
            } else {
                $('#pin-cancel').removeClass('d-none')
            }
            // Show passkey button only when a callback is provided and passkey is active
            if (onPasskeyClick && isPasskeyEnabled()) {
                _pinPasskeyCallback = onPasskeyClick;
                $('#pin-modal-pk-btn').removeClass('d-none');
            } else {
                $('#pin-modal-pk-btn').addClass('d-none');
            }
            $('#pin-modal').modal({ backdrop: 'static', keyboard: false })
            $('#pin-modal').modal('show')
            setTimeout(function() { $('#pin-input').focus() }, 400)
        })
    }
    function validatePinStrength(p) {
        if (!p || p.length < 8)          return getText('pin-too-short')   || 'Minimum 8 characters';
        if (!/[A-Z]/.test(p))            return getText('pin-need-upper')  || 'Requires uppercase letter (A–Z)';
        if (!/[a-z]/.test(p))            return getText('pin-need-lower')  || 'Requires lowercase letter (a–z)';
        if (!/[0-9]/.test(p))            return getText('pin-need-digit')  || 'Requires a digit (0–9)';
        if (!/[^A-Za-z0-9]/.test(p))     return getText('pin-need-special')|| 'Requires special character (!@#$…)';
        return null;
    }
    async function askPinSetup() {
        var pin = await askPin(
            getText('pin-create-title'),
            getText('pin-create-desc'),
            validatePinStrength,
            false
        )
        if (pin === null) return null
        var confirmed = await askPin(
            getText('pin-confirm-title'),
            getText('pin-confirm-desc'),
            function(p) { return (p !== pin) ? getText('pin-mismatch') : null },
            false
        )
        pin = null
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
        if (type == null || !['bech32', 'segwit', 'legacy', 'taproot'].includes(type)) {
            type = 'taproot'
            try { localStorage.setItem('bte_cfg_type', type) } catch(e) {}
        }
        return type
    }
    function switchAddressType(type) {
        if (['bech32', 'segwit', 'legacy', 'taproot'].includes(type)) try { localStorage.setItem('bte_cfg_type', type) } catch(e) {}
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
    function saveUtxoCache(address, utxos, height, balance) {
        try {
            localStorage.setItem('bte_utxo_' + address, JSON.stringify({
                utxos: utxos, height: height, balance: balance || 0, ts: Date.now()
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
        return intPart + '.' + fracPart
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
        var container = document.getElementById('qr-code-addres');
        container.innerHTML = '';
        var canvas = document.createElement('canvas');
        container.appendChild(canvas);
        QRCode.toCanvas(canvas, text, { width: 256, margin: 2, color: { dark: '#000000', light: '#ffffff' } });
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
    var _revealedWords = [];
    var _seedState = {
        words: [],
        enc: null,
        tempKey: null,
        verifyHashes: [],
        strength: 256
    }
    TxHistory.init({
        globalData:    globalData,
        escHtml:       escHtml,
        getText:       getText,
        getBackend:    getBackend,
        getConfig:     getConfig,
        amountFormat:  amountFormat,
        blockExplorer: blockExplorer
    });
    function _hideSeedReveal() {
        if (_revealedWords.length) { _revealedWords.fill(''); _revealedWords = []; }
        $('#wallet-seed-hidden').removeClass('d-none')
        $('#wallet-seed-revealed').addClass('d-none')
        $('#wallet-seed-grid').empty()
    }
    // ── Render seed words as canvas cells (used by both new-seed flow and _revealSeed) ──
    function seedRenderGrid(words, containerId) {
        var $g = $(containerId).empty();
        var cs       = getComputedStyle(document.body);
        var bgColor  = cs.getPropertyValue('--bs-body-bg').trim()        || '#f8f9fa';
        var numColor = cs.getPropertyValue('--bs-secondary-color').trim() || '#6c757d';
        var txtColor = cs.getPropertyValue('--bs-body-color').trim()     || '#212529';
        words.forEach(function(w, i) {
            var canvas = document.createElement('canvas');
            canvas.width = 110; canvas.height = 42;
            canvas.setAttribute('aria-hidden', 'true');
            var ctx = canvas.getContext('2d');
            ctx.fillStyle = bgColor;
            ctx.fillRect(0, 0, 110, 42);
            ctx.fillStyle = numColor;
            ctx.font = '10px sans-serif';
            ctx.fillText(i + 1, 5, 12);
            ctx.fillStyle = txtColor;
            ctx.font = 'bold 13px monospace';
            ctx.fillText(w, 5, 31);
            var $cell = $('<div class="border rounded px-1 py-1 text-center seed-canvas-cell"></div>');
            $cell.append(canvas);
            $g.append($cell);
        });
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
        $('#seed-btn-to-verify').prop('disabled', false)
        clearSensitiveInputs()
        $('#restore-word-error').addClass('d-none')
        $('#restore-path').val(DEFAULT_DERIV_PATH)
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
        TxHistory.renderHistory(TxHistory.loadHistory());
        // Show cached UTXO data immediately so the user never sees "0" while
        // the WebSocket connection is being established (~1 s round-trip).
        // The live balance_changed event will overwrite this as soon as it arrives.
        var _cached = loadUtxoCache(globalData.address);
        if (_cached && Array.isArray(_cached.utxos)) {
            var _ch = _cached.height || 0;
            globalData.height  = _ch;
            globalData.utxos   = _cached.utxos.map(function(u) {
                return Object.assign({}, u, {
                    mature:     isUtxoMature(u, _ch),
                    blocksLeft: blocksToMature(u, _ch)
                });
            });
            // Use the stored balance if available, otherwise sum UTXOs
            globalData.balance = _cached.balance != null
                ? _cached.balance
                : globalData.utxos.reduce(function(s, u) { return s + u.value; }, 0);
        } else {
            globalData.balance         = 0;
            globalData.immatureBalance = 0;
            globalData.utxos           = [];
        }
        _applyUtxoData();
        if (_ws && _wsActive) {
            _ws.emit('subscribe', { address: globalData.address });
        }
    }
    async function openWallet(offerPin, bip39Mnemonic, derivPath) {
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
                await saveWalletBip39(bip39Mnemonic, pin, derivPath);
            } else {
                await saveWalletWif(pin);
            }
            pin = null;
            showMessage(getText('wallet-saved'));
            updateSavedWalletUI();
        }
        bip39Mnemonic = null;
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
                var scriptHex = (typeof u.script === 'string' && u.script) ? u.script : globalData.scriptHex;
                var script    = bitcoin.Buffer.from(scriptHex, 'hex');
                var type      = getScriptType(script);
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
                } else if (type === 'taproot') {
                    var xOnlyPub = pubkey.length === 33 ? pubkey.slice(1) : pubkey;
                    var p2tr = bitcoin.payments.p2tr({ internalPubkey: xOnlyPub, network: getConfig()['network'] });
                    psbt.addInput({
                        hash:         u.txid,
                        index:        u.index,
                        witnessUtxo:  { script: p2tr.output, value: BigInt(u.value) },
                        tapInternalKey: xOnlyPub
                    });
                    inputMeta.push({ type: 'taproot' });
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
        if (script[0] == 0x51 && script[1] == 32) return 'taproot'   // OP_1 <32-byte x-only pubkey>
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
        try { bitcoin.address.fromBech32(address); if (address.toLowerCase().startsWith(network.bech32 + '1p')) return true } catch(e) {}
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
                pin = null
                $('#pin-input').val('')
                _pinPasskeyCallback = null
                $('#pin-modal-pk-btn').addClass('d-none')
                var resolve = _pinResolve
                _pinResolve   = null
                _pinValidator = null
                var modalEl = document.getElementById('pin-modal')
                function onHidden() {
                    modalEl.removeEventListener('hidden.bs.modal', onHidden)
                    resolve(pinValue)
                    pinValue = null
                }
                modalEl.addEventListener('hidden.bs.modal', onHidden)
                $('#pin-modal').modal('hide')
            }
        })
        $('#pin-cancel').click(function() {
            $('#pin-input').val('')
            _pinPasskeyCallback = null
            $('#pin-modal-pk-btn').addClass('d-none')
            if (_pinResolve) {
                var resolve = _pinResolve
                _pinResolve   = null
                _pinValidator = null
                var modalEl = document.getElementById('pin-modal')
                function onHidden() {
                    modalEl.removeEventListener('hidden.bs.modal', onHidden)
                    resolve(null)
                }
                modalEl.addEventListener('hidden.bs.modal', onHidden)
            }
        })
        // ── Passkey button inside pin-modal ───────────────────────────────────
        $('#pin-modal-pk-btn').click(function() {
            var cb = _pinPasskeyCallback;
            _pinPasskeyCallback = null;
            $('#pin-modal-pk-btn').addClass('d-none');
            $('#pin-input').val('');
            if (_pinResolve) {
                var resolve = _pinResolve;
                _pinResolve   = null;
                _pinValidator = null;
                var modalEl   = document.getElementById('pin-modal');
                function onHidden() {
                    modalEl.removeEventListener('hidden.bs.modal', onHidden);
                    resolve(null);   // resolve askPin promise as "cancelled"
                    if (cb) cb();    // then fire passkey action (async, self-contained)
                }
                modalEl.addEventListener('hidden.bs.modal', onHidden);
                $('#pin-modal').modal('hide');
            }
        });
        $('#pin-input').on('keydown', function(e) {
            if (e.key === 'Enter') $('#pin-confirm').click()
        })
        // CapsLock warning — getModifierState not available on most mobile keyboards,
        // graceful no-op in that case
        $(document).on('keyup keydown', '#pin-input, #pin-login-input', function(e) {
            var capsOn = (e.originalEvent && e.originalEvent.getModifierState)
                ? e.originalEvent.getModifierState('CapsLock')
                : false
            var warnId = (this.id === 'pin-input') ? 'pin-caps-warning' : 'pin-login-caps-warning'
            if (capsOn) { $('#' + warnId).removeClass('d-none') }
            else        { $('#' + warnId).addClass('d-none') }
        })
        async function doPinLogin() {
            var pin = $('#pin-login-input').val();
            if (!pin) {
                $('#pin-login-error').text(getText('pin-login-error')).removeClass('d-none');
                return;
            }
            $('#pin-login-btn').prop('disabled', true).text(getText('loading'));
            // Yield one frame so the browser repaints the disabled/loading state
            // before PBKDF2 starts (even though WebCrypto is off-thread, the
            // synchronous bookkeeping before it can delay the repaint).
            await new Promise(function(r) { setTimeout(r, 50); });
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
                walletData = null;
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
        // ── Passkey login button ───────────────────────────────────────────────
        $('#pk-login-btn').click(function(e) {
            e.preventDefault();
            pkAuthenticate();
        });
        // ── Passkey toggle in settings ─────────────────────────────────────────
        $(document).on('click', '#passkey-settings-btn', function(e) {
            e.preventDefault();
            if (isPasskeyEnabled()) {
                pkDisable();
            } else {
                checkPasskeySupport().then(function(supported) {
                    if (!supported) {
                        showMessage(getText('passkey-unsupported') || 'Passkey not supported on this device/browser');
                        return;
                    }
                    pkEnable();
                });
            }
        });
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
            if (tabName === 'wallet-history') TxHistory.updateHistory()
            if (tabName === 'wallet-settings') {
                $('#address-type-select select').val(getAddressType())
                $('#wallet-backend input').val(getBackend())
                if (hasSavedWallet()) {
                    $('#forget-wallet-section').removeClass('d-none')
                } else {
                    $('#forget-wallet-section').addClass('d-none')
                }
                updatePasskeySettingsUI();
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
        $('#toggle-wallet-privkey').click(async function() {
            if ($(this).text() == getText('show')) {
                if (!Keystore.isUnlocked()) return;
                // ── Require PIN (or passkey) before revealing private key ──────
                async function onPasskeyChosen(_retriesLeft) {
                    if (_retriesLeft === undefined) _retriesLeft = 2;
                    var credIdStr = null;
                    try { credIdStr = localStorage.getItem(STORAGE_KEY_PK_ID); } catch(e) {}
                    if (!credIdStr) return;
                    try {
                        var assertion = await navigator.credentials.get({
                            publicKey: {
                                challenge:        crypto.getRandomValues(new Uint8Array(32)),
                                rpId:             window.location.hostname,
                                allowCredentials: [{ type: 'public-key', id: _b64ToCredId(credIdStr) }],
                                userVerification: 'required',
                                extensions:       { prf: { eval: { first: _PK_PRF_SALT } } }
                            }
                        });
                        var ext = assertion.getClientExtensionResults();
                        if (!ext.prf || !ext.prf.results || !ext.prf.results.first) {
                            showMessage(getText('passkey-prf-unsupported') || 'PRF not available');
                            return;
                        }
                        // PRF succeeded — identity confirmed, show privkey
                        revealPrivKeyInput(Keystore.getWIF());
                        $('#wallet-privkey-copy-btn').removeClass('d-none');
                        $('#toggle-wallet-privkey').text(getText('hide'));
                        setTimeout(function() {
                            clearPrivKeyInput();
                            $('#wallet-privkey-copy-btn').addClass('d-none');
                            $('#toggle-wallet-privkey').text(getText('show'));
                        }, 60000);
                    } catch(e) {
                        if (e.name === 'NotAllowedError') return;
                        if (_retriesLeft > 0 && _isTransientPasskeyError(e)) {
                            await new Promise(function(r) { setTimeout(r, 300); });
                            return onPasskeyChosen(_retriesLeft - 1);
                        }
                        showMessage((getText('passkey-error') || 'Passkey error: ') + e.message);
                    }
                }
                var canUsePasskey = isPasskeyEnabled() && hasPasskeyCredential();
                var pin = await askPin(
                    getText('pin-title-default') || 'Wallet PIN',
                    getText('privkey-pin-desc')  || 'Enter PIN to reveal private key',
                    null, false,
                    canUsePasskey ? onPasskeyChosen : null
                );
                if (pin === null) return;  // cancelled or passkey path handled itself
                var walletData = await loadWallet(pin);
                pin = null;
                if (!walletData) {
                    showMessage(getText('pin-login-error') || 'Wrong PIN');
                    return;
                }
                walletData = null;
                revealPrivKeyInput(Keystore.getWIF());
                $('#wallet-privkey-copy-btn').removeClass('d-none');
                $('#toggle-wallet-privkey').text(getText('hide'));
                // Auto-hide after 60 s
                setTimeout(function() {
                    clearPrivKeyInput();
                    $('#wallet-privkey-copy-btn').addClass('d-none');
                    $('#toggle-wallet-privkey').text(getText('show'));
                }, 60000);
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
            // Re-translate any live dynamic UI that isn't covered by tkey attributes
            updatePasskeyUI();
            updateSavedWalletUI();
            if (Keystore.isUnlocked()) {
                setHomeTitle();
                TxHistory.renderHistory(TxHistory.loadHistory());
                if (!$('#coin-control-panel').hasClass('d-none')) renderCoinControl();
                // Re-translate toggle-wallet-privkey button text based on current state
                var $togBtn = $('#toggle-wallet-privkey');
                if ($togBtn.length) {
                    var isShowing = $('#wallet-privkey-input').attr('type') === 'text';
                    $togBtn.text(isShowing ? getText('hide') : getText('show'));
                }
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
        // seedRenderGrid is defined at module scope — accessible here too
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
            clearSeedState();
            var mnemonic = bip39Bundle.generateMnemonic(_seedState.strength);
            _seedState.words = mnemonic.split(' ');
            mnemonic = '';
            seedRenderGrid(_seedState.words, '#seed-word-grid');
        }
        $('#seed-btn-print').click(function() {
            if (!_seedState.words.length) return;
            var mn = _seedState.words.join(' ');
            window.seedExportPNG(mn, getText, DEFAULT_DERIV_PATH);
            mn = '';
        })
        $('#seed-btn-to-verify').click(async function() {
            if (!_seedState.words.length) return;
            var $btn = $(this).prop('disabled', true);
            var words = _seedState.words;
            var len = words.length;
            function rnd(lo, hi) {
                var buf = new Uint32Array(1);
                crypto.getRandomValues(buf);
                return lo + (buf[0] % (hi - lo + 1));
            }
            var third = Math.floor(len / 3);
            var pos = [rnd(0, third - 1), rnd(third, third * 2 - 1), rnd(third * 2, len - 1)];

            try {
                _seedState.verifyHashes = await Promise.all(pos.map(async function(p) {
                    var salt = crypto.getRandomValues(new Uint8Array(16));
                    var hmacKey = await crypto.subtle.importKey(
                        'raw', salt, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
                    );
                    var wordBytes = new TextEncoder().encode(words[p].toLowerCase());
                    var sig = new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, wordBytes));
                    wordBytes.fill(0);
                    return { pos: p, salt: Array.from(salt), hash: Array.from(sig) };
                }));
                _seedState.tempKey = await crypto.subtle.generateKey(
                    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
                );
                var iv = crypto.getRandomValues(new Uint8Array(12));
                var plain = new TextEncoder().encode(words.join(' '));
                var ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, _seedState.tempKey, plain);
                plain.fill(0);
                _seedState.enc = { iv: Array.from(iv), data: Array.from(new Uint8Array(ct)) };
                _seedState.words.fill('');
                _seedState.words = [];
                var $fields = $('#seed-verify-fields').empty();
                pos.forEach(function(p) {
                    $fields.append(
                        '<div class="input-group input-group-sm mb-2">' +
                        '<span class="input-group-text seed-verify-num">' + getText('seed-word-num') + ' ' + (p + 1) + '</span>' +
                        '<input type="text" class="form-control font-monospace seed-verify-word" data-pos="' + p + '" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">' +
                        '</div>'
                    );
                });
                $('#seed-verify-error').addClass('d-none');
                $('#seed-create-step1').addClass('d-none');
                $('#seed-create-step2').removeClass('d-none');
                setTimeout(function() { $('.seed-verify-word').first().focus(); }, 100);
            } catch(e) {
                $btn.prop('disabled', false);
                alert('Crypto error: ' + (e.message || e));
            }
        })
        $('#seed-verify-back').click(function() {
            // words are already zeroed after step-2 transition,
            // so going back with an empty grid is a dead end.
            // Regenerate a fresh mnemonic instead.
            $('#seed-create-step2').addClass('d-none')
            $('#seed-create-step1').removeClass('d-none')
            _seedDoGenerate()
        })
        $('#seed-verify-confirm').click(async function() {
            var $btn = $(this).prop('disabled', true);
            var inputs = $('.seed-verify-word');
            var ok = true;
            try {
                for (var i = 0; i < _seedState.verifyHashes.length; i++) {
                    var vh = _seedState.verifyHashes[i];
                    var $inp = inputs.filter('[data-pos="' + vh.pos + '"]');
                    var enteredBytes = new TextEncoder().encode($inp.val().trim().toLowerCase());
                    var salt = new Uint8Array(vh.salt);
                    var hmacKey = await crypto.subtle.importKey(
                        'raw', salt, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
                    );
                    var sig = new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, enteredBytes));
                    enteredBytes.fill(0);
                    if (sig.length !== vh.hash.length) { ok = false; break; }
                    var diff = 0;
                    for (var j = 0; j < sig.length; j++) diff |= sig[j] ^ vh.hash[j];
                    if (diff !== 0) { ok = false; break; }
                }
            } catch(e) { ok = false; }

            _seedState.verifyHashes = [];

            if (!ok) {
                $('#seed-verify-error').removeClass('d-none');
                $btn.prop('disabled', false);
                return;
            }
            $('#seed-verify-error').addClass('d-none');
            try {
                var iv = new Uint8Array(_seedState.enc.iv);
                var ct = new Uint8Array(_seedState.enc.data);
                var pt = new Uint8Array(await crypto.subtle.decrypt(
                    { name: 'AES-GCM', iv: iv }, _seedState.tempKey, ct
                ));
                _seedState.enc = null;
                _seedState.tempKey = null;

                var mnemonic = new TextDecoder().decode(pt);
                pt.fill(0);

                var privBytes = bip39Bundle.mnemonicToPrivKey(mnemonic, DEFAULT_DERIV_PATH);
                var keyPair = bitcoin.ECPair.fromPrivateKey(bitcoin.Buffer.from(privBytes));
                privBytes.fill(0);
                Keystore.setKeyPair(keyPair);
                await openWallet(true, mnemonic, DEFAULT_DERIV_PATH);
                mnemonic = '';
                $btn.prop('disabled', false);
            } catch(err) {
                $btn.prop('disabled', false);
                alert('Key derivation error: ' + err.message);
            }
        });
        $('#restore-wordcount').change(function() {
            var cnt = parseInt($(this).val(), 10)
            var words = $('#restore-input').val().trim().split(/\s+/).filter(Boolean)
            if (cnt === 12 && words.length > 12) {
                $('#restore-input').val(words.slice(0, 12).join(' '))
            }
            $('#restore-word-error').addClass('d-none')
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
            var path = ($('#restore-path').val().trim() || DEFAULT_DERIV_PATH);
            try {
                var privBytes = bip39Bundle.mnemonicToPrivKey(raw, path);
                var keyPair = bitcoin.ECPair.fromPrivateKey(bitcoin.Buffer.from(privBytes));
                privBytes.fill(0);
                Keystore.setKeyPair(keyPair);
                await openWallet(true, raw, path);
                raw = null;
                $('#restore-input').val('');
                clearSeedState();
            } catch(err) {
                raw = null;
                $('#restore-word-error').text(getText('seed-deriv-error') + ' ' + err.message).removeClass('d-none');
            }
        });
        $('#btn-show-seed').click(async function() {
            if (!hasSeedBackup()) return;
            // Passkey path for seed — decrypt from _pk record using PRF
            async function onPasskeyChosen(_retriesLeft) {
                if (_retriesLeft === undefined) _retriesLeft = 2;
                var credIdStr = null;
                try { credIdStr = localStorage.getItem(STORAGE_KEY_PK_ID); } catch(e) {}
                if (!credIdStr) { showMessage(getText('passkey-not-setup') || 'Passkey not set up'); return; }
                try {
                    var assertion = await navigator.credentials.get({
                        publicKey: {
                            challenge:        crypto.getRandomValues(new Uint8Array(32)),
                            rpId:             window.location.hostname,
                            allowCredentials: [{ type: 'public-key', id: _b64ToCredId(credIdStr) }],
                            userVerification: 'required',
                            extensions:       { prf: { eval: { first: _PK_PRF_SALT } } }
                        }
                    });
                    var ext = assertion.getClientExtensionResults();
                    if (!ext.prf || !ext.prf.results || !ext.prf.results.first) {
                        showMessage(getText('passkey-prf-unsupported') || 'PRF not available');
                        return;
                    }
                    var prfBytes = new Uint8Array(ext.prf.results.first);
                    var seedEntropyHex = await loadEncryptedWithKey(STORAGE_KEY_SEED_PK, prfBytes);
                    prfBytes.fill(0);
                    if (!seedEntropyHex) {
                        showMessage(getText('passkey-decrypt-failed') || 'Seed not found via passkey — try PIN');
                        return;
                    }
                    _revealSeed(seedEntropyHex);
                    seedEntropyHex = '';
                } catch(e) {
                    if (e.name === 'NotAllowedError') return;
                    // Auto-retry on transient platform-authenticator errors
                    if (_retriesLeft > 0 && _isTransientPasskeyError(e)) {
                        await new Promise(function(r) { setTimeout(r, 300); });
                        return onPasskeyChosen(_retriesLeft - 1);
                    }
                    showMessage((getText('passkey-error') || 'Passkey error: ') + e.message);
                }
            }
            var title         = getText('seed-pin-modal-title');
            var desc          = getText('seed-pin-modal-desc');
            var entropyHex    = null;
            var canUsePasskey = isPasskeyEnabled() && hasSeedPkBackup();
            while (true) {
                var pin = await askPin(title, desc, null, false, canUsePasskey ? onPasskeyChosen : null);
                if (pin === null) return;  // cancelled or passkey path handled itself
                entropyHex = await loadEncrypted(STORAGE_KEY_SEED, pin);
                pin = null;
                if (entropyHex) break;
                desc = getText('pin-login-error') || 'Wrong PIN, try again.';
            }
            _revealSeed(entropyHex);
            entropyHex = '';
        });
        $('#btn-hide-seed').click(_hideSeedReveal)
        $('#btn-save-seed-png').click(function() {
            if (!_revealedWords.length) return;
            var mn = _revealedWords.join(' ');
            var savedPath; try { savedPath = localStorage.getItem(STORAGE_KEY_PATH); } catch(e) {}
            window.seedExportPNG(mn, getText, savedPath || DEFAULT_DERIV_PATH);
            mn = '';
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
                TxHistory.updateHistory();
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
                saveUtxoCache(globalData.address, globalData.utxos, h, data.balance);
                _applyUtxoData();
                if (globalData.balance !== prevBalance && globalData.address) {
                    TxHistory.updateHistory();
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
