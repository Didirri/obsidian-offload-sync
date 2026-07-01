# Offload Sync (beta)

An Obsidian plugin that syncs a vault to a self-hosted [Offload](https://github.com/) relay. Content-addressed (FastCDC + BLAKE3), resumable, and it runs the same Rust sync engine as the desktop Offload app, compiled to WebAssembly — so a phone and a Mac converge on the same op log instead of fighting over files.

**Status: 0.1.0, beta.** Not hardened for a primary vault yet (see Caveats). Use a disposable test vault first.

## Install (BRAT)

1. Install the **BRAT** plugin from Obsidian's community plugins.
2. BRAT → *Add beta plugin* → paste this repo's URL → Add.
3. Enable **Offload Sync** in Community plugins.
4. In its settings, set **Relay URL** to your Offload relay (e.g. `http://100.x.x.x:4183` over Tailscale).
5. Run the **Offload Sync: Sync now** command (or the ribbon icon).

## How it works

The plugin bundles the Offload engine as WebAssembly (inlined in `main.js`, so it's self-contained on desktop and iOS). On each sync it: stages the vault's current files and diffs them into ops, exchanges ops + content-addressed chunks with the relay over HTTP (`requestUrl`, so it works on mobile), and writes any incoming changes to disk. It only ever rewrites a file whose bytes actually changed, and only deletes files it wrote itself.

## Caveats (beta)

- If a write fails mid-sync, the next scan could author a spurious delete. Hardening in progress — don't point it at an irreplaceable vault yet.
- No conflict-fork UI, no editor-aware merge, and it re-reads the whole vault each sync.

## Building

`main.js` is built from the Offload monorepo (the plugin sources import the WASM package built there). The release `main.js` is fully self-contained.

## License

[MIT](LICENSE)
