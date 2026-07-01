import { App, Notice, Plugin, PluginSettingTab, Setting, requestUrl } from "obsidian";
// esbuild inlines the wasm as bytes (loader: { ".wasm": "binary" }).
import wasmBinary from "../crates/wasm/pkg-web/offload_wasm_bg.wasm";
import init, { Node } from "../crates/wasm/pkg-web/offload_wasm.js";
// @ts-ignore — plain JS module, shared with the headless test.
import { syncOnce } from "./sync.mjs";

interface OffloadSettings {
  relayUrl: string;
  intervalSeconds: number;
}

const DEFAULT_SETTINGS: OffloadSettings = {
  relayUrl: "",
  intervalSeconds: 0,
};

const SNAPSHOT_FILE = "snapshot.bin";

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export default class OffloadPlugin extends Plugin {
  settings: OffloadSettings;
  private node: Node | null = null;
  private syncing = false;
  private ready = false;
  // Paths this plugin has written to disk, so it can safely remove ones that
  // later disappear from the tree without ever touching a pre-existing user file.
  private materialized = new Set<string>();

  async onload() {
    await this.loadSettings();
    await init({ module_or_path: wasmBinary });

    const snap = await this.loadSnapshot();
    this.node = snap ? Node.restore(snap) : new Node();
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
        body: body ? body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) : undefined,
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
  private async scanVault() {
    const node = this.node!;
    node.beginScan();
    for (const file of this.app.vault.getFiles()) {
      const data = await this.app.vault.adapter.readBinary(file.path);
      node.stageFile(file.path, new Uint8Array(data));
    }
    node.commitScan(Date.now());
  }

  /// Write the tree's winning files to disk. Never rewrites a file whose bytes
  /// already match (so it can't clobber an open editor with identical content),
  /// and only deletes files this plugin itself wrote.
  private async materialize() {
    const node = this.node!;
    const adapter = this.app.vault.adapter;
    const want = node.files() as Array<{ path: string; root: string; size: number }>;
    const wantPaths = new Set(want.map((f) => f.path));

    for (const f of want) {
      const bytes = node.readContent(f.root);
      if (!bytes) continue;
      const current = (await adapter.exists(f.path))
        ? new Uint8Array(await adapter.readBinary(f.path))
        : null;
      if (current && bytesEqual(current, bytes)) {
        this.materialized.add(f.path);
        continue; // already current — leave the file (and any open editor) alone
      }
      const dir = f.path.split("/").slice(0, -1).join("/");
      if (dir && !(await adapter.exists(dir))) await adapter.mkdir(dir);
      await adapter.writeBinary(
        f.path,
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      );
      this.materialized.add(f.path);
    }

    for (const p of Array.from(this.materialized)) {
      if (!wantPaths.has(p)) {
        if (await adapter.exists(p)) await adapter.remove(p);
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
    await this.app.vault.adapter.writeBinary(
      this.snapshotPath(),
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    );
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
