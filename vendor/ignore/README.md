# ignore 7.0.6

Bundled `index.js`, `index.d.ts`, and `LICENSE-MIT` from the `ignore@7.0.6` npm package, already used by this repository's development tooling.

Source: https://github.com/kaelzhang/node-ignore

Bundled locally for Git-compatible `.image_ignore` pattern matching. No dependency installation or external process is needed at runtime. See LICENSE-MIT for attribution and license terms.

Local compatibility patch: preserve escaped literal question marks (`\?`) during pattern compilation. The upstream wildcard pass otherwise rewrites this escape. Covered by `test/ignore-patterns.test.cjs`; license unchanged.
