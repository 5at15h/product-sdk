# Commons Registry native qualification

This is the smallest current Registry integration on upstream Product SDK
`@parity/product-sdk@0.45.0` (`1f5ca255d4470ccd763473c7cebc9de9c4c13a1d`).
It adds one pinned development descriptor, an opt-in native V4 Ed25519 creator,
and native submission's explicit `customSignedExtensions`. Generic upstream
signers and contract options retain their existing behavior.

Commons uses `MultiAddress::Id(AccountId32)` and a bare 64-byte Ed25519 signature.
PAPI 3.2.1's standard creator expects a signature enum. `createRegistryTxCreator`
checks the native layout, uses the metadata extension order and PAPI codecs, and
rejects unsupported layouts with `RegistryLayoutError`. Invalid key/signature
lengths produce `RegistrySignatureError`. The signing callback owns the key;
the adapter grants no endpoint role, allowance or authorization.

The nine Rust vectors are copied byte-for-byte from the recorded Chain source.
The `.fixture` suffix keeps this external evidence out of source formatting.
Tests bind their SHA256 and the metadata SHA256 to the descriptor's provenance,
and compare signing bytes, Ed25519 signatures, complete extrinsics and hashes.
They include over-256-byte hashed payloads and reject mutated signatures, wrong
lengths, duplicate extensions, unsupported extension versions and wrong layouts.
Caller overrides follow PAPI's documented enhancer ordering; explicit native
values win over common defaults, and input duplicate identifiers are rejected.

## Reproduce locally

Use Node 22 and the frozen workspace lockfile. From `product-sdk/`:

```sh
pnpm install --frozen-lockfile
pnpm --filter @parity/product-sdk-tx... build
pnpm --filter @parity/product-sdk-descriptors build
pnpm --filter @parity/product-sdk-tx test run
pnpm --filter @parity/product-sdk-tx typecheck
pnpm check
```

Launch the exact Linux `commons` binary named in the descriptor's
`chains/commons-registry/.papi/fixture.json`, on an isolated local Linux machine
or container. Publish RPC only on loopback when using a container:

```sh
commons --dev --tmp --no-mdns --no-hardware-benchmarks \
  --rpc-port 19556 --rpc-methods unsafe
```

Then run:

```sh
COMMONS_REGISTRY_WS=ws://127.0.0.1:19556 \
COMMONS_REGISTRY_EVIDENCE=/absolute/path/live.json \
pnpm --filter @parity/product-sdk-tx test:commons-registry
```

The script verifies the live genesis/runtime/code identity, uses the bundled
Registry descriptor to read native Alice's balance and endpoint policy, rejects
an explicitly signed spec-136 transaction at native validity, then finalizes a
spec-137 `System.remark_with_event` and decodes its events. It verifies the locked
PAPI 3.2.1 and disconnects on completion. Alice is a public development key.
The finalized call establishes signing, forwarding, inclusion, event decoding
and finality; it does not qualify endpoint admission, every Registry dispatchable,
production gateway routing, browser wallets or hardware signing. Registry call
serialization is covered by the independent Rust reference vectors. No July demo
is a current-network acceptance test.

A locally built Mac node can have a different embedded runtime/genesis; it must
not be silently substituted for the recorded Linux fixture. Generation uses
checked-in metadata, never a running arbitrary gateway. The existing upstream
host/container routing model is unchanged.

## Reconcile the ten historical Commons patches

The `commons-0.9.9` branch and July demos remain unchanged. No historical commit
was cherry-picked. Decisions are against the current upstream base:

| Historical commit | Decision | Current evidence |
| --- | --- | --- |
| `3bf9847` mortality environment override | Drop | Native submit already accepts explicit `mortalityPeriod`; existing mortality tests pass. |
| `d74ab43` role-name client cache key | Drop as superseded | Current client cache is shared by genesis with refcounts; chain-client cache/lifecycle and one-follow tests cover it. |
| `010bc3f` Commons Asset Hub/Bulletin/Individuality descriptors | Replace | One actual Registry descriptor, bound to canonical spec137/tx20 metadata and genesis. |
| `ab107a2` custom signed extensions on native submit | Retain intent | `NativeSubmitOptions` forwards the exact object; unit test and native wrong-spec rejection demonstrate delivery. |
| `30d5464` ensureAccountMapped forwarding | Drop | Revive account mapping is outside the current Registry integration. |
| `b3d9877` contracts wrapper forwards entire options | Drop | No Registry Revive wrapper; base `SubmitOptions` remains unchanged, with a compile-time negative assertion. |
| `e752fb3` mortality environment validation | Drop | No environment override was restored. Explicit upstream mortality is covered by existing tests. |
| `4c690f9` ensureContractAccountMapped wrapper | Drop | Registry has no Revive contract requirement in this scope. |
| `5827184` Commons contracts July demo | Preserve historically | No restoration or migration; not applicable to current Registry. |
| `be59d23` Commons cloud July demo | Preserve historically | No restoration or migration; not applicable to current Registry. |

The adapter adds only direct dependencies already present in the frozen upstream
graph (`metadata-builders`, `substrate-bindings`, `rxjs`); it upgrades no PAPI
version. The Registry generator disables a nested descriptor-package install.
The eleven untouched upstream descriptor configs retain their existing installer
behavior; qualification removed task-created nested installs before running live
checks, so those cannot shadow the locked PAPI version.
