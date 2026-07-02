import { App, Notice, Plugin, PluginSettingTab, Setting, TFile, requestUrl } from "obsidian";
// esbuild inlines the wasm as bytes (loader: { ".wasm": "binary" }).
import wasmBinary from "../crates/wasm/pkg-web/offload_wasm_bg.wasm";
import init, { Node } from "../crates/wasm/pkg-web/offload_wasm.js";
// @ts-ignore — plain JS module, shared with the headless test.
import { syncOnce, deleteGuardPhantoms } from "./sync.mjs";

interface OffloadSettings {
  relayUrl: string;
  intervalSeconds: number;
}

const DEFAULT_SETTINGS: OffloadSettings = {
  relayUrl: "",
  intervalSeconds: 0,
};

const SNAPSHOT_FILE = "snapshot.bin";
const ONDISK_FILE = "ondisk.json";
// Every Nth scan re-reads the whole vault instead of trusting the scancache, so a
// file whose mtime+size happened not to change is still reconciled eventually.
const FULL_SCAN_EVERY = 20;

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// A standalone ArrayBuffer holding exactly this view's bytes (our buffers are
// never SharedArrayBuffers, so the cast is safe).
function toArrayBuffer(v: Uint8Array): ArrayBuffer {
  return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer;
}

export default class OffloadPlugin extends Plugin {
  settings: OffloadSettings;
  private node: Node | null = null;
  private syncing = false;
  private ready = false;
  // Paths this plugin has written to disk, so it can safely remove ones that
  // later disappear from the tree without ever touching a pre-existing user file.
  private materialized = new Set<string>();
  // Paths that were actually on disk at the end of the previous scan. A tree
  // file missing from disk is only treated as a real deletion if it was here;
  // otherwise it's an un-materialized file and its delete is suppressed. Persisted
  // so deletions made while the plugin was closed are still handled correctly.
  private lastOnDisk = new Set<string>();
  // Scancache: path -> {mtime, size, root}. When a file's mtime+size are unchanged
  // we stage it by content identity instead of re-reading and re-chunking it.
  private scanCache = new Map<string, { mtime: number; size: number; root: string }>();
  private scanCount = 0;

  async onload() {
    await this.loadSettings();
    await init({ module_or_path: wasmBinary });

    const snap = await this.loadSnapshot();
    this.node = snap ? Node.restore(snap) : new Node();
    this.lastOnDisk = await this.loadOnDisk();
    this.ready = true;

    this.addCommand({
      id: "offload-sync-now",
      name: "Sync now",
      callback: () => this.syncNow(),
    });
    this.addRibbonIcon("refresh-cw", "Offload: sync now", () => this.syncNow());
    this.addSettingTab(new OffloadSettingTab(this.app, this));

    if (this.settings.intervalSeconds > 0) {
      this.registerInterval(
        window.setInterval(() => this.syncNow(), this.settings.intervalSeconds * 1000)
      );
    }
  }

  // ---- relay transport (Obsidian requestUrl: CORS-safe, works on iOS) -----

  private transport() {
    const base = this.settings.relayUrl.replace(/\/+$/, "");
    const call = (method: string, path: string, body?: Uint8Array) =>
      requestUrl({
        url: base + path,
        method,
        body: body ? toArrayBuffer(body) : undefined,
        contentType: "application/octet-stream",
        throw: false,
      });
    return {
      async get(p: string) {
        const r = await call("GET", p);
        if (r.status === 404) return null;
        if (r.status >= 400) throw new Error(`GET ${p} -> ${r.status}`);
        return new Uint8Array(r.arrayBuffer);
      },
      async post(p: string, body: Uint8Array) {
        const r = await call("POST", p, body);
        if (r.status === 404) return null;
        if (r.status >= 400) throw new Error(`POST ${p} -> ${r.status}`);
        return new Uint8Array(r.arrayBuffer);
      },
      async put(p: string, body: Uint8Array) {
        const r = await call("PUT", p, body);
        if (r.status >= 400 && r.status !== 404) throw new Error(`PUT ${p} -> ${r.status}`);
      },
      async has(p: string) {
        const r = await call("HEAD", p);
        return r.status >= 200 && r.status < 300;
      },
    };
  }

  // ---- the sync cycle -----------------------------------------------------

  async syncNow() {
    if (!this.ready || this.syncing || !this.node) return;
    if (!this.settings.relayUrl) {
      new Notice("Offload: set a relay URL in settings first");
      return;
    }
    this.syncing = true;
    try {
      await this.scanVault();
      await syncOnce(this.node, this.transport());
      await this.materialize();
      await this.saveSnapshot(this.node.snapshot());
    } catch (e: any) {
      console.error("Offload sync failed:", e);
      new Notice("Offload sync failed: " + (e?.message ?? e));
    } finally {
      this.syncing = false;
    }
  }

  /// Author local edits: stage every vault file, then diff against the tree.
  /// Unchanged files (same mtime+size as last scan) are staged by content
  /// identity, so an idle vault re-reads and re-chunks nothing. A tree file that
  /// is missing from disk is only allowed to author a delete if it was genuinely
  /// on disk last time (in lastOnDisk); otherwise it is a not-yet-materialized
  /// file and its content is re-staged so no spurious delete is authored. See
  /// deleteGuardPhantoms in sync.mjs.
  private async scanVault() {
    const node = this.node!;
    const adapter = this.app.vault.adapter;
    const currentOnDisk = new Set<string>();
    const stats = new Map<string, { mtime: number; size: number }>();
    // Periodically ignore the cache and re-read everything, as insurance against
    // a file edited without its mtime+size changing.
    const fullScan = this.scanCount % FULL_SCAN_EVERY === 0;
    this.scanCount++;

    node.beginScan();
    for (const file of this.app.vault.getFiles()) {
      let st: { mtime: number; size: number } | null = null;
      try {
        const s = await adapter.stat(file.path);
        if (s) st = { mtime: s.mtime, size: s.size };
      } catch {
        /* fall through to a full read */
      }
      const cached = this.scanCache.get(file.path);
      let staged = false;
      if (!fullScan && st && cached && cached.mtime === st.mtime && cached.size === st.size) {
        staged = node.stageUnchanged(file.path, cached.root);
      }
      if (!staged) {
        const data = await adapter.readBinary(file.path);
        node.stageFile(file.path, new Uint8Array(data));
      }
      currentOnDisk.add(file.path);
      if (st) stats.set(file.path, st);
    }

    const tree = node.files() as Array<{ path: string; root: string; size: number }>;
    for (const f of deleteGuardPhantoms(tree, currentOnDisk, this.lastOnDisk)) {
      const bytes = node.readContent(f.root);
      if (bytes) node.stageFile(f.path, bytes); // suppress spurious delete
    }
    node.commitScan(Date.now());

    // Refresh the scancache from the freshly committed tree (path -> content root).
    const rootByPath = new Map<string, string>();
    for (const f of node.files() as Array<{ path: string; root: string }>) {
      rootByPath.set(f.path, f.root);
    }
    const next = new Map<string, { mtime: number; size: number; root: string }>();
    for (const [path, st] of stats) {
      const root = rootByPath.get(path);
      if (root) next.set(path, { mtime: st.mtime, size: st.size, root });
    }
    this.scanCache = next;

    this.lastOnDisk = currentOnDisk;
    await this.saveOnDisk();
  }

  /// Write the tree's winning files to disk, plus any conflict forks (the losing
  /// sides of concurrent edits, named "<file> (conflict ...)") so both sides are
  /// visible and nothing is silently overwritten — exactly like the native app.
  /// Writes go through the Vault API so an open note updates cleanly instead of
  /// firing "modified externally, merging". Never rewrites a file whose bytes
  /// already match, and only removes files this plugin itself wrote (to the
  /// recoverable .trash, never a hard delete).
  private async materialize() {
    const node = this.node!;
    const vault = this.app.vault;
    const adapter = vault.adapter;
    const want = node.files() as Array<{ path: string; root: string; size: number }>;
    const forks = node.forks() as Array<{ path: string; root: string; size: number }>;
    const desired = [...want, ...forks];
    const wantPaths = new Set(desired.map((f) => f.path));

    for (const f of desired) {
      // Per-file so one failed write can't abort the whole cycle and leave the
      // rest of the tree un-materialized. Files that fail here simply stay a gap;
      // the delete-safety guard keeps the scan from turning that gap into a delete.
      try {
        const bytes = node.readContent(f.root);
        if (!bytes) continue;
        const current = (await adapter.exists(f.path))
          ? new Uint8Array(await adapter.readBinary(f.path))
          : null;
        if (current && bytesEqual(current, bytes)) {
          this.materialized.add(f.path);
          continue; // already current — leave the file (and any open editor) alone
        }
        const buf = toArrayBuffer(bytes);
        const existing = vault.getAbstractFileByPath(f.path);
        if (existing instanceof TFile) {
          await vault.modifyBinary(existing, buf); // editor-aware update
        } else if (existing) {
          console.error("Offload: refusing to overwrite non-file at " + f.path);
          continue;
        } else if (await adapter.exists(f.path)) {
          // On disk but not in Obsidian's index yet — a raw write is the safe fallback.
          await adapter.writeBinary(f.path, buf);
        } else {
          const dir = f.path.split("/").slice(0, -1).join("/");
          if (dir && !vault.getAbstractFileByPath(dir)) {
            try {
              await vault.createFolder(dir);
            } catch {
              /* already exists / raced */
            }
          }
          await vault.createBinary(f.path, buf);
        }
        this.materialized.add(f.path);
      } catch (e) {
        console.error("Offload: failed to materialize " + f.path, e);
      }
    }

    for (const p of Array.from(this.materialized)) {
      if (!wantPaths.has(p)) {
        const af = vault.getAbstractFileByPath(p);
        if (af) await vault.trash(af, false); // recoverable local .trash, never a hard delete
        else if (await adapter.exists(p)) await adapter.remove(p);
        this.materialized.delete(p);
      }
    }
  }

  // ---- persistence --------------------------------------------------------

  private snapshotPath(): string {
    return `${this.manifest.dir}/${SNAPSHOT_FILE}`;
  }

  private async loadSnapshot(): Promise<Uint8Array | null> {
    try {
      const p = this.snapshotPath();
      if (await this.app.vault.adapter.exists(p)) {
        return new Uint8Array(await this.app.vault.adapter.readBinary(p));
      }
    } catch (e) {
      console.error("Offload: failed to load snapshot", e);
    }
    return null;
  }

  private async saveSnapshot(bytes: Uint8Array) {
    await this.app.vault.adapter.writeBinary(this.snapshotPath(), toArrayBuffer(bytes));
  }

  private ondiskPath(): string {
    return `${this.manifest.dir}/${ONDISK_FILE}`;
  }

  private async loadOnDisk(): Promise<Set<string>> {
    try {
      const p = this.ondiskPath();
      if (await this.app.vault.adapter.exists(p)) {
        const raw = await this.app.vault.adapter.read(p);
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) return new Set(arr);
      }
    } catch (e) {
      console.error("Offload: failed to load on-disk index", e);
    }
    return new Set(); // safe default: an empty set only ever suppresses deletes
  }

  private async saveOnDisk() {
    try {
      await this.app.vault.adapter.write(
        this.ondiskPath(),
        JSON.stringify(Array.from(this.lastOnDisk))
      );
    } catch (e) {
      console.error("Offload: failed to save on-disk index", e);
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

class OffloadSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: OffloadPlugin) {
    super(app, plugin);
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Relay URL")
      .setDesc("Your Offload relay, e.g. http://100.87.44.1:4182 (over Tailscale).")
      .addText((t) =>
        t
          .setPlaceholder("http://host:port")
          .setValue(this.plugin.settings.relayUrl)
          .onChange(async (v) => {
            this.plugin.settings.relayUrl = v.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Auto-sync interval")
      .setDesc("Seconds between automatic syncs. 0 = manual only (reload to apply).")
      .addText((t) =>
        t
          .setValue(String(this.plugin.settings.intervalSeconds))
          .onChange(async (v) => {
            const n = parseInt(v, 10);
            this.plugin.settings.intervalSeconds = Number.isFinite(n) && n >= 0 ? n : 0;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl).addButton((b) =>
      b.setButtonText("Sync now").setCta().onClick(() => this.plugin.syncNow())
    );
  }
}
