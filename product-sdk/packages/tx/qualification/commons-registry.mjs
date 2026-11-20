// Run only against the canonical release's disposable --chain dev fixture.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createClient, Binary } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { createDerive, DEV_MINI_SECRET, ed25519, ed25519Derive, ss58Encode } from "@polkadot-labs/hdkd-helpers";
import { createRegistryTxCreator, submitAndWatch, TxValidityError } from "../dist/index.js";
import { commons_registry } from "../../descriptors/chains/commons-registry/generated/dist/index.js";

const fixtureUrl = new URL("../../descriptors/chains/commons-registry/.papi/fixture.json", import.meta.url);
const fixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
const ws = process.env.COMMONS_REGISTRY_WS ?? "ws://127.0.0.1:19556";
const url = new URL(ws);
assert.equal(url.protocol, "ws:");
assert(["127.0.0.1", "localhost"].includes(url.hostname), "qualification uses local fixture only");
const http = ws.replace(/^ws:/, "http:");
async function rpc(method, params = []) {
    const response = await fetch(http, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const value = await response.json();
    assert(!value.error, JSON.stringify(value.error));
    return value.result;
}
const genesis = await rpc("chain_getBlockHash", [0]);
const runtime = await rpc("state_getRuntimeVersion");
const codeHash = await rpc("state_getStorageHash", ["0x3a636f6465"]);
assert.equal(genesis, fixture.genesis);
assert.equal(codeHash, fixture.runtimeCodeBlake2_256);
assert.equal(runtime.specName, "commons");
assert.equal(runtime.specVersion, fixture.specVersion);
assert.equal(runtime.transactionVersion, fixture.transactionVersion);
assert.equal(commons_registry.genesis, genesis);
const metadata = await readFile(new URL("../../descriptors/chains/commons-registry/.papi/metadata/commons_registry.scale", import.meta.url));
assert.equal(createHash("sha256").update(metadata).digest("hex"), fixture.metadataSha256);

const key = createDerive({ seed: DEV_MINI_SECRET, curve: ed25519, derive: ed25519Derive })("//Alice");
const address = ss58Encode(key.publicKey, 42);
const signed = [];
const signer = createRegistryTxCreator(key.publicKey, (bytes) => { signed.push(Buffer.from(bytes).toString("hex")); return key.sign(bytes); });
const client = createClient(getWsProvider(ws));
const papiVersion = JSON.parse(await readFile(new URL("../node_modules/polkadot-api/package.json", import.meta.url), "utf8")).version;
assert.equal(papiVersion, "3.2.1", "qualification uses the locked upstream PAPI");
const record = { papiVersion, fixture, runtime, genesis, codeHash, publicKey: Buffer.from(key.publicKey).toString("hex"), endpoint: ws, statuses: [] };
const json = (value) => JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item, 2);
try {
    const api = client.getTypedApi(commons_registry);
    const account = await api.query.System.Account.getValue(address);
    assert(account.data.free > 0n, "native Ed25519 Alice must be funded");
    const policy = await api.query.Endpoints.CurrentPolicy.getValue();
    assert(policy != null && Number(policy.revision) > 0);
    record.registryPolicy = policy;
    const tx = api.tx.System.remark_with_event({ remark: Binary.fromText("Commons/native-registry") });
    const bad = await submitAndWatch(tx, signer, { waitFor: "finalized", timeoutMs: 90_000, mortalityPeriod: 64, customSignedExtensions: { CheckSpecVersion: { additionalSigned: 136 } } });
    record.negative = bad.ok ? { unexpectedSuccess: bad.value } : { name: bad.error.name, message: bad.error.message, reason: bad.error.reason };
    assert(!bad.ok, "wrong spec implicit must not be silently replaced or finalized");
    assert(bad.error instanceof TxValidityError, "wrong spec must reach native validity rejection");
    const result = await submitAndWatch(tx, signer, { waitFor: "finalized", timeoutMs: 90_000, mortalityPeriod: 64, customSignedExtensions: { CheckSpecVersion: { additionalSigned: 137 } }, onStatus: (status) => record.statuses.push(status) });
    assert(result.ok, result.ok ? "" : result.error.message);
    assert(result.value.ok && result.value.block.number > 0);
    assert(record.statuses.includes("finalized"));
    assert(result.value.events.some((event) => event.type === "System" && event.value?.type === "Remarked"), "native Remarked event must decode");
    assert.equal(signed.length, 2, "both negative and successful calls must sign natively");
    const finalized = await rpc("chain_getFinalizedHead");
    const header = await rpc("chain_getHeader", [finalized]);
    assert(Number.parseInt(header.number, 16) >= result.value.block.number);
    record.finalized = result.value;
    record.signedPayloads = signed;
    record.result = "PASS";
} catch (error) {
    record.result = "FAIL";
    record.error = { name: error.name, message: error.message, stack: error.stack };
    throw error;
} finally {
    client.destroy();
    const output = process.env.COMMONS_REGISTRY_EVIDENCE;
    if (output) await writeFile(output, `${json(record)}\n`);
    console.log(json(record));
}
