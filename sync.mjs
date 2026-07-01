// Transport-agnostic Offload sync core, shared by the headless test and the
// Obsidian plugin. `node` is an instantiated WASM Node (the byte-sensitive
// engine); `t` is a Transport to the relay. This only moves bytes over HTTP and
// asks the node what to move — it never parses CBOR or touches content itself.
//
// Transport contract:
//   get(path)        -> Uint8Array | null   (null on 404)
//   post(path, body) -> Uint8Array | null
//   put(path, body)  -> void
//   has(path)        -> boolean              (HEAD 200 vs 404)

// Push everything this node has that the relay lacks. Content (manifest +
// chunks) is transferred BEFORE the ops that reference it, so the relay never
// holds an op pointing at content it cannot serve.
export async function pushToRelay(node, t) {
  const relayVv = (await t.get("/vv")) ?? new Uint8Array();
  const localOps = node.opsSince(relayVv);
  for (const root of node.contentsInOps(localOps)) {
    const manifest = node.getManifest(root);
    if (!manifest) continue;
    await t.put("/manifest", manifest);
    for (const h of node.chunksOf(root)) {
      if (!(await t.has("/chunk/" + h))) {
        const bytes = node.readChunk(h);
        if (bytes) await t.put("/chunk/" + h, bytes);
      }
    }
  }
  await t.post("/ops", localOps);
}

// Pull everything the relay has that this node lacks, fetching content before
// ingesting the ops so every file can be materialised.
export async function pullFromRelay(node, t) {
  const relayOps = (await t.post("/ops/since", node.vv())) ?? new Uint8Array();
  for (const root of node.contentsInOps(relayOps)) {
    if (!node.getManifest(root)) {
      const manifest = await t.get("/manifest/" + root);
      if (manifest) node.putManifest(manifest);
    }
    for (const h of node.chunksOf(root)) {
      if (!node.hasChunk(h)) {
        const bytes = await t.get("/chunk/" + h);
        if (bytes) node.writeChunk(h, bytes);
      }
    }
  }
  node.ingestOps(relayOps);
}

// One full bidirectional sync with the relay. Idempotent and resumable.
export async function syncOnce(node, t) {
  await pushToRelay(node, t);
  await pullFromRelay(node, t);
}
