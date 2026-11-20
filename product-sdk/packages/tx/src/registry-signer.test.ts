// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { getDynamicBuilder, getLookupFn } from "@polkadot-api/metadata-builders";
import { ed25519 } from "@polkadot-labs/hdkd-helpers";
import {
    Blake2256,
    decAnyMetadata,
    metadata as metadataCodec,
    unifyMetadata,
} from "@polkadot-api/substrate-bindings";
import type { TxCreator } from "polkadot-api/tx-creator";
import { fromHex, toHex } from "polkadot-api/utils";
import { EMPTY, of } from "rxjs";
import { expect, test, vi } from "vitest";
import type { SubmitOptions } from "./types.js";
import {
    createRegistryTxCreator,
    RegistryLayoutError,
    RegistrySignatureError,
} from "./registry-signer.js";

type AssertFalse<T extends false> = T;
// Keeps upstream contract TxOptions (which extends SubmitOptions) free of the native-only option.
type _GenericOptionsDoNotExposeNativeExtensions = AssertFalse<
    "customSignedExtensions" extends keyof SubmitOptions ? true : false
>;

const metadataBytes = readFileSync(
    new URL(
        "../../descriptors/chains/commons-registry/.papi/metadata/commons_registry.scale",
        import.meta.url,
    ),
);
const vectors = JSON.parse(
    readFileSync(
        new URL("../qualification/fixtures/commons-registry-signing.fixture", import.meta.url),
        "utf8",
    ),
);
const fixture = JSON.parse(
    readFileSync(
        new URL("../../descriptors/chains/commons-registry/.papi/fixture.json", import.meta.url),
        "utf8",
    ),
);
test("canonical Chain metadata and Rust vectors match their provenance", () => {
    expect(createHash("sha256").update(metadataBytes).digest("hex")).toBe(fixture.metadataSha256);
    expect(
        createHash("sha256")
            .update(
                readFileSync(
                    new URL(
                        "../qualification/fixtures/commons-registry-signing.fixture",
                        import.meta.url,
                    ),
                ),
            )
            .digest("hex"),
    ).toBe(fixture.signingVectorsSha256);
});
type Payload = Parameters<TxCreator<[]>>[0];
type Vector = (typeof vectors.cases)[number];
const unified = unifyMetadata(decAnyMetadata(metadataBytes));
if (!("signature" in unified.extrinsic))
    throw new Error("fixture requires explicit signature metadata");
const signatureTypeId = getLookupFn(unified)(unified.extrinsic.signature).id;
const builder = getDynamicBuilder(getLookupFn(unified));
const pipeline = unified.extrinsic.extensionsByVersion[0];

function payload(vector: Vector): Payload {
    const explicit = fromHex(vector.extensionExplicit);
    const implicit = fromHex(vector.extensionImplicit);
    let valueOffset = 0;
    let implicitOffset = 0;
    const extensions = pipeline.map((extension) => {
        // Owning metadata codecs split the Rust reference's aggregate extension
        // bytes. Re-encoding checks canonical lengths; no alternate SCALE parser.
        const valueCodec = builder.buildDefinition(extension.type);
        const implicitCodec = builder.buildDefinition(extension.additionalSigned);
        const extra = valueCodec.enc(valueCodec.dec(explicit.slice(valueOffset)));
        const additional = implicitCodec.enc(implicitCodec.dec(implicit.slice(implicitOffset)));
        valueOffset += extra.length;
        implicitOffset += additional.length;
        return {
            id: extension.identifier,
            extra: toHex(extra),
            additionalSigned: toHex(additional),
        };
    });
    expect(valueOffset).toBe(explicit.length);
    expect(implicitOffset).toBe(implicit.length);
    return {
        version: 1,
        signer: null,
        callData: vector.call,
        extensions,
        txExtVersion: 0,
        context: {
            metadata: toHex(metadataBytes),
            token: null,
            bestBlockHeight: vectors.currentBlock,
            bestBlockHash: vectors.mortalityCheckpoint.hash,
            genesisHash: vectors.genesisHash,
        },
    };
}
const bindings = {
    blocks: EMPTY,
    call: () => {
        throw new Error("complete Rust vector must need no runtime lookup");
    },
    hasher: (bytes: Uint8Array) => of(Blake2256(bytes)),
};

for (const vector of vectors.cases) {
    test(`native Rust signing and extrinsic bytes: ${vector.name}`, async () => {
        const seed = fromHex(
            vector.signerPublicKey === vectors.voucherIssuer.publicKey
                ? vectors.voucherIssuer.seed
                : vectors.signer.seed,
        );
        const key = ed25519.getPublicKey(seed);
        expect(toHex(key)).toBe(vector.signerPublicKey);
        const sign = vi.fn((bytes: Uint8Array) => ed25519.sign(bytes, seed));
        const creator = createRegistryTxCreator(key, sign);
        const input = payload(vector);
        // Payload array order is immaterial; metadata owns the signed order.
        input.extensions.reverse();
        const encoded = await creator(input, {}, bindings, false);
        expect(toHex(sign.mock.calls[0][0])).toBe(vector.signingBytes);
        expect(toHex(sign.mock.results[0].value)).toBe(vector.signature);
        expect(encoded).toBe(vector.extrinsic);
        expect(toHex(Blake2256(fromHex(encoded)))).toBe(vector.extrinsicHash);
        const changed = fromHex(vector.signingBytes);
        changed[0] ^= 1;
        expect(ed25519.verify(fromHex(vector.signature), changed, key)).toBe(false);
    });
}

test("explicit native custom extension wins over the common default", async () => {
    const vector = vectors.cases[0];
    const signed: Uint8Array[] = [];
    const creator = createRegistryTxCreator(fromHex(vector.signerPublicKey), (bytes) => {
        signed.push(bytes);
        return ed25519.sign(bytes, fromHex(vectors.signer.seed));
    });
    const options = {
        nonce: vector.nonce,
        customSignedExtensions: { CheckSpecVersion: { additionalSigned: 136 } },
    };
    await creator(payload(vector), options, bindings, false);
    const expected = fromHex(vector.signingBytes);
    // Rust's reference implicit bytes begin with spec137's little-endian u32.
    expected[fromHex(vector.call).length + fromHex(vector.extensionExplicit).length] = 136;
    expect(signed).toEqual([expected]);
});

test("rejects invalid public-key and signing-result lengths separately from layout", async () => {
    expect(() => createRegistryTxCreator(new Uint8Array(31), () => new Uint8Array(64))).toThrow(
        RegistrySignatureError,
    );
    const creator = createRegistryTxCreator(
        fromHex(vectors.signer.publicKey),
        () => new Uint8Array(63),
    );
    await expect(creator(payload(vectors.cases[0]), {}, bindings, false)).rejects.toThrow(
        RegistrySignatureError,
    );
});

test("rejects duplicate extension identifiers and unsupported extension version", async () => {
    const creator = createRegistryTxCreator(
        fromHex(vectors.signer.publicKey),
        () => new Uint8Array(64),
    );
    const duplicate = payload(vectors.cases[0]);
    duplicate.extensions.push(duplicate.extensions[0]);
    await expect(creator(duplicate, {}, bindings, false)).rejects.toThrow(RegistryLayoutError);
    const unexpected = payload(vectors.cases[0]);
    unexpected.extensions[0] = { ...unexpected.extensions[0], id: "UnexpectedNativeExtension" };
    await expect(creator(unexpected, {}, bindings, false)).rejects.toThrow(RegistryLayoutError);
    const v5 = payload(vectors.cases[0]);
    v5.txExtVersion = 1;
    await expect(creator(v5, {}, bindings, false)).rejects.toThrow(RegistryLayoutError);
});

test("rejects an unexpected signature/address layout instead of guessing MultiSignature", async () => {
    const raw = decAnyMetadata(metadataBytes);
    if (raw.metadata.tag !== "v16") throw new Error("fixture must be V16");
    const v16 = raw.metadata.value;
    const signature = v16.lookup.find(({ id }) => id === signatureTypeId)!;
    if (signature.def.tag !== "array") throw new Error("fixture signature must be fixed array");
    signature.def.value.len = 65;
    const input = payload(vectors.cases[0]);
    input.context.metadata = toHex(metadataCodec.enc(raw));
    const creator = createRegistryTxCreator(
        fromHex(vectors.signer.publicKey),
        () => new Uint8Array(64),
    );
    await expect(creator(input, {}, bindings, false)).rejects.toThrow(/signature layout/);
    signature.def.value.len = 64;
    raw.metadata.value.extrinsic.address = 1;
    input.context.metadata = toHex(metadataCodec.enc(raw));
    await expect(creator(input, {}, bindings, false)).rejects.toThrow(/MultiAddress/);
});

test("fee-estimation mock has a native signature without invoking the key", async () => {
    const sign = vi.fn(() => new Uint8Array(64));
    const creator = createRegistryTxCreator(fromHex(vectors.signer.publicKey), sign);
    await creator(payload(vectors.cases[0]), {}, bindings, true);
    expect(sign).not.toHaveBeenCalled();
});
