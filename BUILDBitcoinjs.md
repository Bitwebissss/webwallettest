# bitcoin-bundle-v7.min.js — Reproducible Build Guide

This document allows anyone to reproduce the browser library bundle for
auditing purposes. The resulting `bitcoin-bundle-v7.min.js` is loaded by
the Bitweb web wallet (bitcoinjs-lib v6+ no longer ships a ready-made browser
file, so the bundle is built from source).

**Changelog vs previous version:**
- Removed `@bitcoinerlab/secp256k1` — replaced with a direct adapter over `@noble/curves`
  (Paul Miller, Cure53 audited). Eliminates a one-person intermediary package.
- Added `bitcoin.ecc` export — required by `wallet.js` for BIP341 taproot key-path
  signing (`privateNegate`, `privateAdd`).
- Entry point: `var` → `const`/`let` throughout.
- `bufToBigInt` / `bigIntToBuffer32` helpers — private key material never touches a
  hex string; avoids immutable JS string copies of key bytes in GC heap.
- `const { secp256k1, schnorr } = require(...)` — direct destructuring, no intermediate variable.
- `--target=es2020` — targets modern browsers only; no ES5 transpilation.

---

## Requirements

| Tool    | Minimum version                                       | Check            |
|---------|-------------------------------------------------------|------------------|
| Node.js | **≥ 20.0.0** (ecpair requires ≥20; Node 22 supported) | `node --version` |
| npm     | ≥ 10                                                  | `npm --version`  |
| Internet | registry.npmjs.org                                   | —                |

---

## RNG Audit

| Library | RNG used | Source |
|---------|----------|--------|
| `ecpair → makeRandom()` | `crypto.getRandomValues` | `globalThis.crypto` |
| `@noble/hashes` (dep of @noble/curves) | `crypto.getRandomValues` | `globalThis.crypto.getRandomValues` |

**Verified in bundle (Node 22 + npm 10):**
- `getRandomValues` — **7 occurrences**: 2 calls + 2 typeof-checks + 2 error strings + 1 ecpair call.
  Count varies with Node/npm version (different resolution of `@noble/hashes` copies). Any value ≥ 4 is correct.
- `Math.random` — absent (0 occurrences)
- `node:crypto` / `require('crypto')` — absent (0 occurrences)
- `@bitcoinerlab` — absent

**RNG chain in the browser:**
```
ECPair.makeRandom()
  → crypto.getRandomValues(new Uint8Array(32))   ← ecpair source
      → window.crypto.getRandomValues             ← Web Crypto API
          → OS CSPRNG  (/dev/urandom Linux, CryptGenRandom Windows)
```

---

## Step 1 — Create working directory

```bash
mkdir bte-wallet-bundle
cd bte-wallet-bundle
npm init -y
```

---

## Step 2 — Install exact pinned versions

Install one package at a time for reliability:

```bash
npm install --save-exact bitcoinjs-lib@7.0.1
npm install --save-exact ecpair@3.0.1
npm install --save-exact @noble/curves@1.8.1
npm install --save-exact esbuild@0.28.0
npm install --save-exact buffer@6.0.3
```

### What each package does

| Package | Version | Purpose | Repository |
|---------|---------|---------|------------|
| bitcoinjs-lib | 7.0.1 | Core: Psbt, payments, opcodes, address | github.com/bitcoinjs/bitcoinjs-lib |
| ecpair | 3.0.1 | Key management (split from bitcoinjs-lib in v6+) | github.com/bitcoinjs/ecpair |
| @noble/curves | 1.8.1 | secp256k1 curve — pure JS, Cure53 audited, Paul Miller | github.com/paulmillr/noble-curves |
| esbuild | 0.28.0 | Bundler: ESM+CJS → single browser file | github.com/evanw/esbuild |
| buffer | 6.0.3 | Browser polyfill for Node.js Buffer | github.com/feross/buffer |

### Why @noble/curves directly?

`@bitcoinerlab/secp256k1` is a 65-line wrapper over `@noble/curves` with one
maintainer and no release in 2+ years. This build uses `@noble/curves` directly
with a small adapter (~70 lines) that implements the exact interface required by
`ecpair` and `bitcoinjs-lib v7`. Fewer dependencies = smaller attack surface.

### Expected integrity hashes (sha512, npm registry — identical on all machines)

```
bitcoinjs-lib@7.0.1
  sha512-vwEmpL5Tpj0I0RBdNkcDMXePoaYSTeKY6mL6/l5esbnTs+jGdPDuLp4NY1hSh6Zk5wSgePygZ4Wx5JJao30Pww==

ecpair@3.0.1
  sha512-uz8wMFvtdr58TLrXnAesBsoMEyY8UudLOfApcyg40XfZjP+gt1xO4cuZSIkZ8hTMTQ8+ETgt7xSIV4eM7M6VNw==

@noble/curves@1.8.1
  sha512-warwspo+UYUPep0Q+vtdVB4Ugn8GGQj8iyB3gnRWsztmUHTI3S1nhdiWNsPUGL0vud7JlRRk1XEu7Lq1KGTnMQ==

buffer@6.0.3
  sha512-FTiCpNxtwiZZHEZbcbTIcZjERVICn9yq/pDFkTl95/AxzD1naBctN7YO68riM/gLSDY7sdrMby8hofADYuuqOA==

esbuild@0.28.0
  sha512-sNR9MHpXSUV/XB4zmsFKN+QgVG82Cc7+/aaxJ8Adi8hyOac+EXptIp45QBPaVyX3N70664wRbTcLTOemCAnyqw==
```

### Automated integrity check

> **Note:** never use `node -e "..."` for scripts containing `!` — bash treats `!`
> inside double quotes as history expansion. Always save to a file first.

```bash
cat > check_integrity.js << 'EOF'
const fs = require('fs')
const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'))
const expected = {
  'bitcoinjs-lib':  'sha512-vwEmpL5Tpj0I0RBdNkcDMXePoaYSTeKY6mL6/l5esbnTs+jGdPDuLp4NY1hSh6Zk5wSgePygZ4Wx5JJao30Pww==',
  'ecpair':         'sha512-uz8wMFvtdr58TLrXnAesBsoMEyY8UudLOfApcyg40XfZjP+gt1xO4cuZSIkZ8hTMTQ8+ETgt7xSIV4eM7M6VNw==',
  '@noble/curves':  'sha512-warwspo+UYUPep0Q+vtdVB4Ugn8GGQj8iyB3gnRWsztmUHTI3S1nhdiWNsPUGL0vud7JlRRk1XEu7Lq1KGTnMQ==',
  'buffer':         'sha512-FTiCpNxtwiZZHEZbcbTIcZjERVICn9yq/pDFkTl95/AxzD1naBctN7YO68riM/gLSDY7sdrMby8hofADYuuqOA==',
  'esbuild':        'sha512-sNR9MHpXSUV/XB4zmsFKN+QgVG82Cc7+/aaxJ8Adi8hyOac+EXptIp45QBPaVyX3N70664wRbTcLTOemCAnyqw==',
}
let ok = true
for (const [pkg, hash] of Object.entries(expected)) {
  const entry = lock.packages['node_modules/' + pkg]
  if (!entry) { console.log('MISSING:', pkg); ok = false; continue }
  if (entry.integrity !== hash) {
    console.log('HASH MISMATCH:', pkg)
    console.log('  expected:', hash)
    console.log('  got:     ', entry.integrity)
    ok = false
  } else {
    console.log('OK:', pkg + '@' + entry.version)
  }
}
if (ok) console.log('\n✅ All integrity hashes match')
else { console.log('\n❌ INTEGRITY CHECK FAILED — do not use this build'); process.exit(1) }
EOF

node check_integrity.js
```

Expected output:
```
OK: bitcoinjs-lib@7.0.1
OK: ecpair@3.0.1
OK: @noble/curves@1.8.1
OK: buffer@6.0.3
OK: esbuild@0.28.0

✅ All integrity hashes match
```

---

## Step 3 — Create the entry point

Single quotes around `EOF` are required:

```bash
cat > entry_bundle.js << 'EOF'
const { Buffer } = require('buffer')
globalThis.Buffer = Buffer

const bitcoin = require('bitcoinjs-lib')
const { ECPairFactory } = require('ecpair')
const { secp256k1, schnorr } = require('@noble/curves/secp256k1')

// Direct adapter over @noble/curves/secp256k1 (Paul Miller, Cure53 audited).
// Implements the full interface required by ecpair + bitcoinjs-lib v7.
const ecc = (function() {
  const G     = secp256k1.ProjectivePoint.BASE
  const ORDER = secp256k1.CURVE.n

  // Buffer → BigInt without intermediate hex string.
  // Private key material avoids hex strings because n.toString(16) produces
  // an immutable JS string containing key bytes that cannot be zeroed.
  // BigInt values are themselves immutable — a fundamental JS language limit
  // shared by all pure-JS crypto libs including @noble/curves itself.
  function bufToBigInt(buf) {
    let n = 0n
    for (let i = 0; i < buf.length; i++) {
      n = (n << 8n) | BigInt(buf[i])
    }
    return n
  }

  // BigInt → 32-byte Buffer without intermediate hex string
  function bigIntToBuffer32(n) {
    const buf = Buffer.allocUnsafe(32)
    for (let i = 31; i >= 0; i--) {
      buf[i] = Number(n & 0xffn)
      n >>= 8n
    }
    return buf
  }

  // Public/point data only — hex strings are acceptable here
  function toHex(buf) { return Buffer.from(buf).toString('hex') }

  function isPoint(p) {
    if (!p || (p.length !== 33 && p.length !== 65)) return false
    try { secp256k1.ProjectivePoint.fromHex(toHex(p)); return true }
    catch(e) { return false }
  }

  function isXOnlyPoint(p) {
    if (!p || p.length !== 32) return false
    try { secp256k1.ProjectivePoint.fromHex('02' + toHex(p)); return true }
    catch(e) { return false }
  }

  // Private key check — bufToBigInt avoids hex string of key material
  function isPrivate(d) {
    if (!d || d.length !== 32) return false
    const n = bufToBigInt(d)
    return n > 0n && n < ORDER
  }

  function pointCompress(p, compressed) {
    const pt = secp256k1.ProjectivePoint.fromHex(toHex(p))
    return pt.toRawBytes(compressed !== false)
  }

  // Private key input — bufToBigInt avoids hex string of key material
  function pointFromScalar(d, compressed) {
    if (!isPrivate(d)) return null
    const pt = G.multiply(bufToBigInt(d))
    return pt.toRawBytes(compressed !== false)
  }

  function xOnlyPointAddTweak(p, tweak) {
    try {
      const px = secp256k1.ProjectivePoint.fromHex('02' + toHex(p))
      const t = bufToBigInt(tweak)
      if (t >= ORDER) return null
      const result = px.add(G.multiply(t))
      if (result.equals(secp256k1.ProjectivePoint.ZERO)) return null
      const raw = result.toRawBytes(true)
      return { parity: raw[0] === 3 ? 1 : 0, xOnlyPubkey: raw.slice(1) }
    } catch(e) { return null }
  }

  // Both inputs are key material — no hex strings
  function privateAdd(d, tweak) {
    const dn = bufToBigInt(d)
    const tn = bufToBigInt(tweak)
    const result = (dn + tn) % ORDER
    if (result === 0n) return null
    return bigIntToBuffer32(result)
  }

  // Input is key material — no hex strings
  function privateNegate(d) {
    const dn = bufToBigInt(d)
    const result = (ORDER - dn) % ORDER
    return bigIntToBuffer32(result)
  }

  function sign(hash, priv, extra) {
    const sig = secp256k1.sign(hash, priv, { lowS: true, extraEntropy: extra || undefined })
    return sig.toCompactRawBytes()
  }

  function verify(hash, pub, sig, strict) {
    try {
      const s = secp256k1.Signature.fromCompact(sig)
      if (strict && s.hasHighS()) return false
      return secp256k1.verify(s, hash, pub)
    } catch(e) { return false }
  }

  function signSchnorr(hash, priv, extra) {
    return schnorr.sign(hash, priv, extra)
  }

  function verifySchnorr(hash, pub, sig) {
    try { return schnorr.verify(sig, hash, pub) }
    catch(e) { return false }
  }

  return {
    isPoint, isXOnlyPoint, isPrivate,
    pointCompress, pointFromScalar, xOnlyPointAddTweak,
    privateAdd, privateNegate,
    sign, verify, signSchnorr, verifySchnorr
  }
})()

bitcoin.initEccLib(ecc)
bitcoin.ECPair = ECPairFactory(ecc)
bitcoin.Buffer = Buffer
bitcoin.ecc    = ecc

module.exports = bitcoin
EOF
```

---

## Step 4 — Build the bundle

`--target=es2020` targets Chrome 80+, Firefox 72+, Safari 13.1+.
No ES5 transpilation — BigInt, arrow functions, and classes are native.

```bash
./node_modules/.bin/esbuild entry_bundle.js \
  --bundle \
  --platform=browser \
  --target=es2020 \
  --global-name=bitcoin \
  --outfile=bitcoin-bundle-v7.min.js \
  --minify \
  --define:global=globalThis \
  '--banner:js=var process={env:{NODE_ENV:"production"},browser:true,version:"v18.0.0",versions:{},platform:"browser",nextTick:function(fn,a,b,c){return setTimeout(function(){fn(a,b,c)},0)},hrtime:function(){return[0,0]},exit:function(){},on:function(){return this}};'
```

Expected output:

```
  bitcoin-bundle-v7.min.js  ~350–380kb

⚡ Done in ~100–150ms
```

> Exact size depends on Node/npm version. 366–376 kb is the correct range.

---

## Step 5 — Verify RNG in bundle (security audit)

```bash
# getRandomValues must be present (7 occurrences; exact count varies with Node version):
grep -o "getRandomValues" bitcoin-bundle-v7.min.js | wc -l

# Math.random must be ABSENT:
if grep -q "Math\.random" bitcoin-bundle-v7.min.js; then echo "❌ PROBLEM: Math.random found"; else echo "✅ OK: Math.random absent"; fi

# node:crypto must be ABSENT:
if grep -qE "node:crypto|require\(.*crypto" bitcoin-bundle-v7.min.js; then echo "❌ PROBLEM: node:crypto found"; else echo "✅ OK: no node:crypto"; fi

# @bitcoinerlab must be ABSENT:
if grep -q "bitcoinerlab" bitcoin-bundle-v7.min.js; then echo "❌ PROBLEM: bitcoinerlab found in bundle"; else echo "✅ OK: no bitcoinerlab"; fi

# Confirm all getRandomValues calls go through globalThis.crypto:
grep -oE '.{50}getRandomValues.{50}' bitcoin-bundle-v7.min.js
```

Expected output:
```
7
✅ OK: Math.random absent
✅ OK: no node:crypto
✅ OK: no bitcoinerlab
...globalThis.crypto...getRandomValues...
...crypto.getRandomValues(new Uint8Array...
```

> `getRandomValues` = 0 means the bundle is broken. `Math.random` or `node:crypto` present = stop deploy immediately.
> `bitcoinerlab` present = bundle was built from old guide, rebuild.

---

## Step 6 — Test the bundle

```bash
npm install --save-exact jsdom
```

```bash
cat > test_bundle.js << 'EOF'
const { JSDOM } = require('jsdom')
const fs = require('fs')
const crypto = require('crypto')

const dom = new JSDOM('<!DOCTYPE html>', { runScripts: 'dangerously' })
const w = dom.window
w.onerror = (msg) => { console.error('JS error:', msg); process.exit(1) }

// Must use Object.defineProperty — jsdom exposes window.crypto as a getter backed
// by Node.js crypto. Simple assignment (w.crypto = ...) is silently ignored.
// defineProperty overrides it correctly, allowing us to count actual RNG calls.
let rngCallCount = 0
Object.defineProperty(w, 'crypto', {
  configurable: true,
  writable: true,
  value: {
    getRandomValues: (buf) => {
      rngCallCount++
      crypto.randomFillSync(buf)
      return buf
    }
  }
})

w.document.head.appendChild(
  Object.assign(w.document.createElement('script'),
  { textContent: fs.readFileSync('bitcoin-bundle-v7.min.js', 'utf8') })
)

const b = w.bitcoin
if (!b) { console.error('FAIL: window.bitcoin is undefined'); process.exit(1) }

let allOk = true
function check(label, value, expected) {
  const ok = expected === undefined ? !!value : value === expected
  console.log((ok ? '✅' : '❌') + ' ' + label + (ok ? '' : '  got: ' + JSON.stringify(value)))
  if (!ok) allOk = false
}

// Key generation
const k  = b.ECPair.makeRandom()
const k2 = b.ECPair.fromPrivateKey(
  b.Buffer.from('0101010101010101010101010101010101010101010101010101010101010101', 'hex')
)
const k3 = b.ECPair.fromWIF(k.toWIF())
check('ECPair.makeRandom',        k.publicKey.length, 33)
check('ECPair.fromPrivateKey',    k2.publicKey.length, 33)
check('ECPair.fromWIF roundtrip',
  b.Buffer.from(k3.publicKey).toString('hex'),
  b.Buffer.from(k.publicKey).toString('hex'))
check('getRandomValues was called (RNG audit)', rngCallCount > 0, true)

// ecc export — required by wallet.js taproot signing (BIP341)
check('bitcoin.ecc exported',                  typeof b.ecc, 'object')
check('bitcoin.ecc.privateAdd is function',    typeof b.ecc.privateAdd,         'function')
check('bitcoin.ecc.privateNegate is function', typeof b.ecc.privateNegate,      'function')
check('bitcoin.ecc.signSchnorr is function',   typeof b.ecc.signSchnorr,        'function')
check('bitcoin.ecc.xOnlyPointAddTweak is fn',  typeof b.ecc.xOnlyPointAddTweak, 'function')
check('bitcoin.crypto.taggedHash is fn',       typeof b.crypto.taggedHash,      'function')

// Address types
const addr_bech32 = b.payments.p2wpkh({ pubkey: k.publicKey }).address
const addr_legacy = b.payments.p2pkh({ pubkey: k.publicKey }).address
const p2wpkh      = b.payments.p2wpkh({ pubkey: k.publicKey })
const addr_segwit = b.payments.p2sh({ redeem: p2wpkh }).address
check('p2wpkh address (bech32)', addr_bech32.startsWith('bc1q'))
check('p2pkh  address (legacy)', addr_legacy.startsWith('1'))
check('p2sh   address (segwit)', addr_segwit.startsWith('3'))

// Buffer operations
// In v7 publicKey is Uint8Array, NOT Buffer — must wrap with Buffer.from()
const pubHex = b.Buffer.from(k.publicKey).toString('hex')
check('Buffer.from(publicKey).toString(hex) length', pubHex.length, 66)
check('pubkey compressed prefix (02 or 03)', pubHex[1] === '2' || pubHex[1] === '3')

const scriptHex = b.Buffer.from(b.payments.p2wpkh({ pubkey: k.publicKey }).output).toString('hex')
check('output.toString(hex) is proper hex, not comma array', !scriptHex.includes(','))
check('p2wpkh scriptHex length == 44', scriptHex.length, 44)

const redeemHex = '0014' + b.Buffer.from(p2wpkh.hash).toString('hex')
check('redeemScript hex length == 44', redeemHex.length, 44)
check('redeemScript starts with 0014',  redeemHex.startsWith('0014'))

// Psbt with BigInt values (v7 requirement — plain Number throws)
const psbt = new b.Psbt()
try {
  psbt.addOutput({ address: addr_bech32, value: BigInt(100000) })
  psbt.addOutput({ address: addr_legacy, value: BigInt(50000) })
  check('Psbt.addOutput with BigInt', true)
} catch(e) { check('Psbt.addOutput with BigInt', false) }

// Signing
const hash = b.Buffer.from('0101010101010101010101010101010101010101010101010101010101010101', 'hex')
const sig  = k2.sign(hash)
check('sign returns 64 bytes', sig.length, 64)
check('verify signature (sign/verify roundtrip)', k2.verify(hash, sig), true)

// Deterministic signing RFC6979 — same message must produce identical signature
const sig2 = k2.sign(hash)
let sigSame = sig.length === sig2.length
for (let i = 0; i < sig.length; i++) if (sig[i] !== sig2[i]) { sigSame = false; break }
check('deterministic signing RFC6979 (sign twice = same sig)', sigSame, true)

// Schnorr signing (BIP340)
const schnorrSig  = k2.signSchnorr(hash)
check('signSchnorr returns 64 bytes (BIP340)', schnorrSig.length, 64)
check('verifySchnorr (roundtrip)', k2.verifySchnorr(hash, schnorrSig), true)

// Schnorr uses random nonce — two signatures differ but both verify
const schnorrSig2 = k2.signSchnorr(hash)
check('Schnorr second signature also verifies', k2.verifySchnorr(hash, schnorrSig2), true)
let schnorrDiffer = false
for (let i = 0; i < schnorrSig.length; i++) if (schnorrSig[i] !== schnorrSig2[i]) { schnorrDiffer = true; break }
check('Schnorr signatures differ (random nonce)', schnorrDiffer, true)

// Opcodes
check('opcodes.OP_0',       b.opcodes.OP_0,       0)
check('opcodes.OP_DUP',     b.opcodes.OP_DUP,     118)
check('opcodes.OP_HASH160', b.opcodes.OP_HASH160,  169)

// Address decode
b.address.fromBech32(addr_bech32)
check('address.fromBech32',      true)
b.address.fromBase58Check(addr_legacy)
check('address.fromBase58Check', true)

// Two random keys must differ
const kA = b.ECPair.makeRandom()
const kB = b.ECPair.makeRandom()
check('two random keys are different',
  b.Buffer.from(kA.publicKey).toString('hex') !== b.Buffer.from(kB.publicKey).toString('hex'), true)

console.log('')
if (allOk) { console.log('✅ ALL TESTS PASSED\nBundle is safe to deploy.') }
else { console.log('❌ SOME TESTS FAILED — do not deploy this build'); process.exit(1) }
EOF
```

Run it:

```bash
node test_bundle.js
```

Every line must show `✅` and the final line must be `ALL TESTS PASSED`.

---

## Step 7 — Compute your hashes and deploy

Bundle hashes depend on the build environment (Node + npm version). There is no
canonical hash — compute yours after building and record it as the reference for
future rebuilds on the same machine.

```bash
# Size:
wc -c bitcoin-bundle-v7.min.js

# SRI hash:
echo "sha512-$(openssl dgst -sha512 -binary bitcoin-bundle-v7.min.js | openssl base64 -A)"
```

**Verified hashes (Node 22.22.2 + npm 10.9.7):**
```
375455 bytes
sha512-ZvJaGRVOy+mQDs+QPKbLYPcf71tMvVQcHn3CqvQ3ImNnG/K6XTnCXp5/Y+4MIwPXQe7nvCBBo+dp+ko8fJ7R6Q==
```

```bash
cp bitcoin-bundle-v7.min.js ../js/bitcoin-bundle-v7.min.js
```

In `index.html`, add the SRI hash:

```html
<!-- Self build — see BUILDBitcoinjs.md -->
<script src="js/bitcoin-bundle-v7.min.js"
        integrity="sha512-YOUR_HASH_FROM_ABOVE=="
        crossorigin="anonymous"></script>
```

> Without `integrity=` the browser loads the file without verification.
> With it, the browser refuses to execute the file if the hash does not match.

---

## Summary of security properties

| Property | Status | Detail |
|----------|--------|--------|
| RNG source | ✅ `crypto.getRandomValues` | → `window.crypto` → OS CSPRNG |
| `Math.random` | ✅ Absent | 0 occurrences in bundle |
| `node:crypto` in bundle | ✅ Absent | esbuild `--platform=browser` excludes Node crypto |
| `@bitcoinerlab/secp256k1` | ✅ Absent | Direct `@noble/curves` adapter used |
| `bitcoin.ecc` exported | ✅ | `privateAdd`, `privateNegate`, `signSchnorr`, `xOnlyPointAddTweak` |
| `getRandomValues` verified in test | ✅ | Explicit mock via `Object.defineProperty` + call counter |
| sign/verify roundtrip tested | ✅ | `k2.verify(hash, sig)` |
| Deterministic signing RFC6979 | ✅ | sign twice = same result |
| Schnorr random nonce | ✅ | Two signatures differ, both verify |
| Two random keys differ | ✅ | RNG entropy confirmed |
| SRI integrity in HTML | ✅ | sha512 attribute required |
| Package integrity | ✅ Pinned | sha512 from npm registry — identical on all machines |
| Target browsers | ✅ Modern only | `--target=es2020`: Chrome 80+, Firefox 72+, Safari 13.1+ |
| Bundle hash | ℹ️ Per-environment | esbuild deterministic locally; compute in Step 7 |

---

## Notes for auditors

### Private key material: what is eliminated and what remains

The adapter avoids intermediate hex strings for private key material using byte-level helpers:

```
bufToBigInt(buf)      — Buffer → BigInt by shifting bytes, no toString()
bigIntToBuffer32(n)   — BigInt → Buffer by masking bytes, no toString(16)
```

| Function | String leak eliminated |
|---|---|
| `isPrivate(d)` | `bufToBigInt(d)` — no hex string |
| `pointFromScalar(d)` | `bufToBigInt(d)` — no hex string |
| `privateAdd(d, tweak)` | `bufToBigInt` + `bigIntToBuffer32` — no hex strings |
| `privateNegate(d)` | `bufToBigInt` + `bigIntToBuffer32` — no hex strings |

**What cannot be eliminated:** BigInt values holding key material are immutable in JS
and cannot be zeroed. `@noble/curves` itself operates on BigInt internally. This is
unavoidable in any pure-JS crypto library without WASM.

**Caller responsibility:** `privateAdd` and `privateNegate` return a `Buffer` containing
key material. The caller must `fill(0)` it after use.

### Why `bitcoin.ecc` is exported

`wallet.js` implements BIP341 taproot key-path signing. It must compute the tweaked
private key: `tweaked = (privKey [negated if y is odd]) + TapTweak(xOnly) mod n`.
This requires `ecc.privateNegate` and `ecc.privateAdd` — curve arithmetic primitives
not exposed in bitcoinjs-lib v7's public API. Exporting `ecc` from the bundle is
cleaner than duplicating the arithmetic in `wallet.js`.

### v7 breaking change: BigInt

In bitcoinjs-lib v7 all satoshi values in Psbt must be `BigInt`, not `Number`:

```js
// Correct (v7):
psbt.addOutput({ address: addr, value: BigInt(amount) })
witnessUtxo: { script: output, value: BigInt(utxo.value) }

// Wrong — works in v5/v6, throws in v7:
psbt.addOutput({ address: addr, value: amount })
```

### v7 breaking change: Uint8Array instead of Buffer

`keys.publicKey`, `.output`, and `.hash` on payment objects return `Uint8Array` in
v7, not `Buffer`. Always wrap before calling `.toString('hex')`:

```js
// Correct:
bitcoin.Buffer.from(keys.publicKey).toString('hex')   // → "02a1b2..."
bitcoin.Buffer.from(payment.output).toString('hex')
bitcoin.Buffer.from(payment.hash).toString('hex')

// Wrong — returns "2,161,178,..." instead of hex:
keys.publicKey.toString('hex')
```

### Why @noble/curves directly instead of tiny-secp256k1?

`tiny-secp256k1` uses WebAssembly and requires an async init step (`await ecc.init()`)
before it can be used as a plain `<script>` tag. `@noble/curves` is pure JavaScript
with no WASM, maintained by Paul Miller (Cure53 audited), and widely used across the
Bitcoin/Ethereum ecosystem. The adapter in Step 3 implements the full
`tiny-secp256k1`-compatible interface that `ecpair` and `bitcoinjs-lib v7` expect.
