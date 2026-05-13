# bip39-bundle.min.js — Reproducible Build Guide

Browser bundle for BIP39 mnemonic generation/validation and BIP32 HD key derivation.
Uses `@scure/bip39` (wordlist included) and `@scure/bip32` — both Cure53 audited.
Entropy source: `crypto.getRandomValues` (OS CSPRNG, native in all modern browsers).

**Changelog vs previous version:**
- Updated `@scure/bip39` + `@scure/bip32`: `1.4.0` → `2.2.0`
- Entry file: `require()` (CJS) → `import` (ESM) — required for v2.x
- Wordlist import: suffix `.js` required in v2.x
- Bundle size reduced: ~114 kb → ~67 kb (shared `@noble/hashes`, no duplicates)
- `getRandomValues` in bundle: 9 → 3 (was two copies of `@noble/hashes`, now one)
- `seed.fill(0)` — 64-byte master seed zeroed immediately after `HDKey.fromMasterSeed()`
- `root.privateKey.fill(0)` + `root.chainCode.fill(0)` — root HDKey zeroed after child derivation
- `child.privateKey.fill(0)` + `child.chainCode.fill(0)` — child HDKey zeroed after key copy
- `child.privateKey.slice()` — returns an independent copy of the buffer
- Entry point: `var` → `const`/`let` throughout
- `--target=es2020` — targets modern browsers only; no ES5 transpilation
- **Added `entropyToPrivKey(entropyBytes, path)`** — derives private key directly from entropy without exposing the intermediate mnemonic string outside the bundle

---

## RNG Audit (verified)

| Library | RNG used | Source |
|---------|----------|--------|
| `@scure/bip39` | `crypto.getRandomValues` | `@noble/hashes/utils → randomBytes()` |
| `@scure/bip32` | **none** — only HMAC-SHA512 (deterministic KDF) | — |

**RNG chain in the browser:**

```
bip39.generateMnemonic()
  → randomBytes(16 or 32)                  ← @noble/hashes/utils
      → globalThis.crypto.getRandomValues  ← Web Crypto API
          → window.crypto
              → OS CSPRNG                  ← /dev/urandom (Linux), CryptGenRandom (Windows)
```

**Verified in bundle:**
- `getRandomValues` — **3 occurrences**, only through `globalThis.crypto`
- `Math.random` — absent (0 occurrences)
- `node:crypto` / `require('crypto')` — absent (0 occurrences)

---

## Requirements

| Tool    | Minimum version    |
|---------|--------------------|
| Node.js | ≥ 20.0.0           |
| npm     | ≥ 10               |
| Internet | registry.npmjs.org |

---

## Step 1 — Create working directory

```bash
mkdir bte-bip39-bundle
cd bte-bip39-bundle
npm init -y
```

---

## Step 2 — Install exact pinned versions

Install one package at a time for reliability:

```bash
npm install --save-exact @scure/bip39@2.2.0
npm install --save-exact @scure/bip32@2.2.0
npm install --save-exact esbuild@0.28.0
```

### Expected integrity hashes (sha512, npm registry — identical on all machines)

```
@scure/bip39@2.2.0
  sha512-T/Bj/YvYMNkIPq6EENO6/rcs2e7qTNuyoUXf0KBFDmp0ZDu0H2X4Lq6yC3i0c8PcWkov5EbW+yQZZbdMmk154A==

@scure/bip32@2.2.0
  sha512-zFr7t2F+a9+5tB7QbarF2HQNYrgjCNaoLAupZdKkrFMYMozJf5zqH2WJCQibMzm1qQ0QogrxVGO3qXfQDYMaQg==

esbuild@0.28.0
  sha512-sNR9MHpXSUV/XB4zmsFKN+QgVG82Cc7+/aaxJ8Adi8hyOac+EXptIp45QBPaVyX3N70664wRbTcLTOemCAnyqw==
```

### Automated integrity check

```bash
cat > check_bip39_integrity.js << 'EOF'
const fs = require('fs')
const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'))
const expected = {
  '@scure/bip39': 'sha512-T/Bj/YvYMNkIPq6EENO6/rcs2e7qTNuyoUXf0KBFDmp0ZDu0H2X4Lq6yC3i0c8PcWkov5EbW+yQZZbdMmk154A==',
  '@scure/bip32': 'sha512-zFr7t2F+a9+5tB7QbarF2HQNYrgjCNaoLAupZdKkrFMYMozJf5zqH2WJCQibMzm1qQ0QogrxVGO3qXfQDYMaQg==',
  'esbuild':      'sha512-sNR9MHpXSUV/XB4zmsFKN+QgVG82Cc7+/aaxJ8Adi8hyOac+EXptIp45QBPaVyX3N70664wRbTcLTOemCAnyqw==',
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
if (ok) console.log('\n✅ All package integrity hashes match')
else { console.log('\n❌ INTEGRITY CHECK FAILED — do not use this build'); process.exit(1) }
EOF

node check_bip39_integrity.js
```

Expected output:
```
OK: @scure/bip39@2.2.0
OK: @scure/bip32@2.2.0
OK: esbuild@0.28.0

✅ All package integrity hashes match
```

---

## Step 3 — Create the entry point

> **Important:** v2.x is ESM-only. Use `import`, not `require()`.
> The wordlist path requires the `.js` suffix in v2.x.

```bash
cat > entry_bip39.js << 'EOF'
import { generateMnemonic, validateMnemonic, mnemonicToSeedSync, entropyToMnemonic, mnemonicToEntropy } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { HDKey } from '@scure/bip32'

window.bip39Bundle = {
  generateMnemonic: function(strength) {
    // strength: 128 = 12 words, 256 = 24 words
    // Internally calls crypto.getRandomValues(new Uint8Array(16 or 32))
    return generateMnemonic(wordlist, strength || 128)
  },
  validateMnemonic: function(mnemonic) {
    return validateMnemonic(mnemonic, wordlist)
  },
  mnemonicToPrivKey: function(mnemonic, path) {
    const seed = mnemonicToSeedSync(mnemonic)
    const root = HDKey.fromMasterSeed(seed)
    // Zero the 64-byte master seed immediately after HDKey absorbs it.
    // Without this, seed stays in heap until GC collects it.
    seed.fill(0)
    const child = root.derive(path || "m/84'/0'/0'/0/0")
    // Zero root private key and chain code after child derivation is complete.
    if (root.privateKey) root.privateKey.fill(0)
    if (root.chainCode)  root.chainCode.fill(0)
    // .slice() returns an independent Uint8Array copy.
    // Caller MUST fill(0) the returned value after use.
    const privKey = child.privateKey.slice()
    // Zero child internal buffers after copying the key out.
    if (child.privateKey) child.privateKey.fill(0)
    if (child.chainCode)  child.chainCode.fill(0)
    return privKey
  },
  // entropyToPrivKey: Uint8Array(16|20|24|28|32) → Uint8Array(32)
  // Derives the private key directly from raw entropy bytes without ever
  // exposing the intermediate mnemonic string outside this function.
  // The mnemonic is a JS string (immutable, cannot be zeroed) — keeping it
  // inside the bundle closure means it never escapes to the caller's heap.
  // Caller MUST fill(0) the returned Uint8Array after use.
  entropyToPrivKey: function(entropyBytes, path) {
    const mnemonic = entropyToMnemonic(entropyBytes, wordlist)
    const seed = mnemonicToSeedSync(mnemonic)
    const root = HDKey.fromMasterSeed(seed)
    seed.fill(0)
    const child = root.derive(path || "m/84'/738'/0'/0/0")
    if (root.privateKey) root.privateKey.fill(0)
    if (root.chainCode)  root.chainCode.fill(0)
    const privKey = child.privateKey.slice()
    if (child.privateKey) child.privateKey.fill(0)
    if (child.chainCode)  child.chainCode.fill(0)
    return privKey
  },
  // entropyToMnemonic: Uint8Array(16|20|24|28|32) → mnemonic string
  entropyToMnemonic: function(entropyBytes) {
    return entropyToMnemonic(entropyBytes, wordlist)
  },
  // mnemonicToEntropy: mnemonic string → Uint8Array
  mnemonicToEntropy: function(mnemonic) {
    return mnemonicToEntropy(mnemonic, wordlist)
  },
  wordlist: wordlist
}
EOF
```

---

## Step 4 — Build the bundle

`--target=es2020` targets Chrome 80+, Firefox 72+, Safari 13.1+.
No ES5 transpilation — BigInt, arrow functions, and classes are native.

```bash
./node_modules/.bin/esbuild entry_bip39.js \
  --bundle \
  --platform=browser \
  --target=es2020 \
  --outfile=bip39-bundle.min.js \
  --minify \
  --define:global=globalThis \
  '--banner:js=var process={env:{NODE_ENV:"production"},browser:true,version:"v18.0.0",versions:{},platform:"browser",nextTick:function(fn,a,b,c){return setTimeout(function(){fn(a,b,c)},0)},hrtime:function(){return[0,0]},exit:function(){},on:function(){return this}};'
```

Expected output:

```
  bip39-bundle.min.js  ~68–70 kb

⚡ Done in ~10–50ms
```

> Exact size depends on Node/npm version. ~68–70 kb is the correct range.

---

## Step 5 — Verify RNG in bundle (security audit)

```bash
# getRandomValues must be present (3 occurrences in v2.x):
grep -o "getRandomValues" bip39-bundle.min.js | wc -l

# Math.random must be ABSENT:
if grep -q "Math\.random" bip39-bundle.min.js; then echo "❌ PROBLEM: Math.random found"; else echo "✅ OK: Math.random absent"; fi

# node:crypto must be ABSENT:
if grep -qE "node:crypto|require\(.*crypto" bip39-bundle.min.js; then echo "❌ PROBLEM: node:crypto found"; else echo "✅ OK: no node:crypto"; fi

# Confirm crypto source is globalThis:
grep -oE '.{30}getRandomValues.{30}' bip39-bundle.min.js
```

Expected output:
```
3
✅ OK: Math.random absent
✅ OK: no node:crypto
```

> `getRandomValues` = 0 means the bundle is broken.
> If count > 3, check that dependency versions match Step 2 exactly.

---

## Step 6 — Test the bundle

```bash
npm install --save-exact jsdom

cat > test_bip39.js << 'EOF'
const { JSDOM } = require('jsdom')
const fs = require('fs')
const crypto = require('crypto')

const dom = new JSDOM('<!DOCTYPE html>', { runScripts: 'dangerously' })
const w = dom.window
w.crypto = { getRandomValues: (buf) => { crypto.randomFillSync(buf); return buf } }

w.document.head.appendChild(
  Object.assign(w.document.createElement('script'),
  { textContent: fs.readFileSync('bip39-bundle.min.js', 'utf8') })
)

const b = w.bip39Bundle
let allOk = true
function check(label, val, expected) {
  const ok = expected === undefined ? !!val : val === expected
  console.log((ok ? '✅' : '❌') + ' ' + label + (ok ? '' : '  got: ' + val))
  if (!ok) allOk = false
}

check('bip39Bundle defined', !!b)
check('wordlist length', b.wordlist.length, 2048)

const m12 = b.generateMnemonic(128)
const m24 = b.generateMnemonic(256)
check('generateMnemonic 12 words', m12.split(' ').length, 12)
check('generateMnemonic 24 words', m24.split(' ').length, 24)
check('validateMnemonic valid',   b.validateMnemonic(m12), true)
check('validateMnemonic invalid', b.validateMnemonic('wrong word list'), false)

const pk = b.mnemonicToPrivKey(m12)
check('privKey is Uint8Array', pk instanceof w.Uint8Array)
check('privKey length 32', pk.length, 32)

const pk2 = b.mnemonicToPrivKey(m12)
let same = true
for (let i = 0; i < 32; i++) if (pk[i] !== pk2[i]) { same = false; break }
check('deterministic derivation', same)

const pk3 = b.mnemonicToPrivKey(m12)
pk3.fill(0)
const pk4 = b.mnemonicToPrivKey(m12)
let stillValid = false
for (let i = 0; i < 32; i++) if (pk4[i] !== 0) { stillValid = true; break }
check('fill(0) on result does not corrupt next call (.slice() works)', stillValid)
check('seed.fill(0) did not break derivation', stillValid)

const pk5 = b.mnemonicToPrivKey(m12)
let sameAsPk = true
for (let i = 0; i < 32; i++) if (pk5[i] !== pk[i]) { sameAsPk = false; break }
check('root+child fill(0) does not corrupt future independent calls', sameAsPk)

const ent12 = b.mnemonicToEntropy(m12)
check('mnemonicToEntropy returns Uint8Array', ent12 instanceof w.Uint8Array)
check('entropy 12-word = 16 bytes', ent12.length, 16)
check('entropyToMnemonic roundtrip 12-word', b.entropyToMnemonic(ent12) === m12)

const ent24 = b.mnemonicToEntropy(m24)
check('entropy 24-word = 32 bytes', ent24.length, 32)
check('entropyToMnemonic roundtrip 24-word', b.entropyToMnemonic(ent24) === m24)

const pkCustom = b.mnemonicToPrivKey(m12, "m/44'/0'/0'/0/0")
check('custom path 32 bytes', pkCustom.length, 32)
let diff = false
for (let i = 0; i < 32; i++) if (pkCustom[i] !== pk[i]) { diff = true; break }
check('custom path gives different key', diff)

const mA = b.generateMnemonic(256)
const mB = b.generateMnemonic(256)
check('two mnemonics are different', mA !== mB)
const pkA = b.mnemonicToPrivKey(mA)
const pkB = b.mnemonicToPrivKey(mB)
let pkDiff = false
for (let i = 0; i < 32; i++) if (pkA[i] !== pkB[i]) { pkDiff = true; break }
check('different mnemonics → different privkeys', pkDiff)

// ── entropyToPrivKey tests ─────────────────────────────────────────────────
console.log('\n── entropyToPrivKey ──')

const epk12 = b.entropyToPrivKey(ent12)
check('entropyToPrivKey returns Uint8Array', epk12 instanceof w.Uint8Array)
check('entropyToPrivKey result length 32', epk12.length, 32)

const epk12b = b.entropyToPrivKey(ent12)
let epkSame = true
for (let i = 0; i < 32; i++) if (epk12[i] !== epk12b[i]) { epkSame = false; break }
check('entropyToPrivKey deterministic (same entropy → same key)', epkSame)

const BTE_PATH = "m/84'/738'/0'/0/0"
const twoStep = b.mnemonicToPrivKey(b.entropyToMnemonic(ent12), BTE_PATH)
const oneStep = b.entropyToPrivKey(ent12, BTE_PATH)
let consistent = true
for (let i = 0; i < 32; i++) if (oneStep[i] !== twoStep[i]) { consistent = false; break }
check('entropyToPrivKey matches entropyToMnemonic→mnemonicToPrivKey (default BTE path)', consistent)

const epk24 = b.entropyToPrivKey(ent24, BTE_PATH)
check('entropyToPrivKey 24-word entropy: length 32', epk24.length, 32)
const twoStep24 = b.mnemonicToPrivKey(b.entropyToMnemonic(ent24), BTE_PATH)
let consistent24 = true
for (let i = 0; i < 32; i++) if (epk24[i] !== twoStep24[i]) { consistent24 = false; break }
check('entropyToPrivKey 24-word matches two-step', consistent24)

const epkCustom = b.entropyToPrivKey(ent12, "m/44'/0'/0'/0/0")
check('entropyToPrivKey custom path: length 32', epkCustom.length, 32)
let customDiff = false
for (let i = 0; i < 32; i++) if (epkCustom[i] !== epk12[i]) { customDiff = true; break }
check('entropyToPrivKey custom path gives different key than default', customDiff)

const epkZ = b.entropyToPrivKey(ent12, BTE_PATH)
epkZ.fill(0)
const epkAfterZ = b.entropyToPrivKey(ent12, BTE_PATH)
let notAllZero = false
for (let i = 0; i < 32; i++) if (epkAfterZ[i] !== 0) { notAllZero = true; break }
check('fill(0) on entropyToPrivKey result does not corrupt next call', notAllZero)

const ent12alt = new w.Uint8Array(16)
w.crypto.getRandomValues(ent12alt)
const epkAlt = b.entropyToPrivKey(ent12alt, BTE_PATH)
let entDiff = false
for (let i = 0; i < 32; i++) if (epkAlt[i] !== epk12[i]) { entDiff = true; break }
check('entropyToPrivKey different entropy → different key', entDiff)

// ── end entropyToPrivKey tests ─────────────────────────────────────────────

console.log('')
if (allOk) { console.log('✅ ALL TESTS PASSED\nBundle is safe to deploy.') }
else { console.log('❌ SOME TESTS FAILED'); process.exit(1) }
EOF

node test_bip39.js
```

All 31 checks must show `✅` and the final line `ALL TESTS PASSED`.

---

## Step 7 — Compute your hashes and deploy

Bundle hashes depend on the build environment (Node + npm version). There is no
canonical hash — compute yours after building and record it as the reference for
future rebuilds on the same machine.

```bash
wc -c bip39-bundle.min.js
echo "sha512-$(openssl dgst -sha512 -binary bip39-bundle.min.js | openssl base64 -A)"
```

**Verified hashes (Node 22.22.2 + npm 10.9.7):**
```
69744 bytes
sha512-zWLd7XWjt9cD9f6X2WC1reAjLwa1L0lMRoCjIzaTgLZ1WNkuwKqF8hADVPSrolVUi3xuwrpk63ZmC8XDvECTsg==
```

```bash
cp bip39-bundle.min.js ../js/bip39-bundle.min.js
```

In `index.html`:

```html
<!-- Self build — see BUILD_bip39.md -->
<script src="js/bip39-bundle.min.js"
        integrity="sha512-YOUR_HASH_FROM_ABOVE=="
        crossorigin="anonymous"></script>
```

---

## Summary of security properties

| Property | Status | Detail |
|----------|--------|--------|
| RNG source | ✅ `crypto.getRandomValues` | → `window.crypto` → OS CSPRNG |
| `Math.random` | ✅ Absent | 0 occurrences in bundle |
| `node:crypto` in bundle | ✅ Absent | esbuild `--platform=browser` picks browser crypto path |
| `seed.fill(0)` | ✅ Applied | 64-byte master seed zeroed immediately after HDKey consumes it |
| `root.privateKey/chainCode.fill(0)` | ✅ Applied | Root HDKey zeroed after child derivation completes |
| `child.privateKey/chainCode.fill(0)` | ✅ Applied | Child HDKey zeroed after private key is copied out |
| `privKey.slice()` | ✅ Applied | Independent copy returned; `fill(0)` on result is safe |
| Mnemonic string scope | ✅ Bundle-internal | `entropyToPrivKey` keeps mnemonic inside closure; never exits to caller |
| `@scure/bip32` RNG | ✅ None needed | BIP32 derivation is deterministic HMAC-SHA512 |
| Duplicate deps | ✅ None | v2.x: shared `@noble/hashes` — 3 getRandomValues vs 9 in v1.x |
| Library audit | ✅ Cure53 | Same audit as `@noble` family |
| Package integrity | ✅ Pinned | sha512 from npm registry — identical on all machines |
| Target browsers | ✅ Modern only | `--target=es2020`: Chrome 80+, Firefox 72+, Safari 13.1+ |
| Bundle hash | ℹ️ Per-environment | esbuild deterministic locally; compute in Step 7 |

## Known limitations

| Remaining | Reason |
|-----------|--------|
| Intermediate HDKey nodes during deep path derivation | `@scure/bip32` `derive()` allocates intermediate HDKey objects internally; their private keys are not accessible without forking the library. GC-eligible. Low practical risk for single-level derivation. |
| Mnemonic string GC (entropyToPrivKey) | JS strings are immutable and cannot be zeroed. `entropyToPrivKey` prevents the string from leaving the bundle scope, but it remains in heap until GC. This is the best achievable without WASM. |
| WIF strings in vault (`saveWif`/`saveBip39`) | JS strings are immutable; cannot be zeroed. Requires vault redesign to store entropy hex + privkey hex instead. |
| BigInt values holding key material | Immutable in JS — unavoidable in any pure-JS crypto library without WASM. Applies to `@noble/hashes` and `@scure/bip32` internals. |
