// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { getLookupFn } from "@polkadot-api/metadata-builders";
import {
    type CommonSignerTxCreator,
    getSignBytes,
    withCommonExtensions,
    withNonce,
} from "@polkadot-api/signers-common";
import {
    compact,
    decAnyMetadata,
    extrinsicFormat,
    unifyMetadata,
} from "@polkadot-api/substrate-bindings";
import type { TxCreator } from "polkadot-api/tx-creator";
import { fromHex, mergeUint8, toHex } from "polkadot-api/utils";
import { firstValueFrom } from "rxjs";

/** Metadata or transaction layout is outside the Registry's native V4 contract. */
export class RegistryLayoutError extends Error {
    name = "RegistryLayoutError";
}

/** Public-key or signature bytes do not have the native Ed25519 shape. */
export class RegistrySignatureError extends Error {
    name = "RegistrySignatureError";
}

/**
 * A creator for Commons Registry's MultiAddress::Id(AccountId32), bare Ed25519
 * signature and native V4 extension pipeline. Upstream's standard creator requires
 * MultiSignature, so it cannot encode this layout. Extension values remain owned
 * by the caller and PAPI's common extension/nonce enhancers.
 */
export function createRegistryTxCreator(
    publicKey: Uint8Array,
    sign: (bytes: Uint8Array) => Uint8Array | Promise<Uint8Array>,
): CommonSignerTxCreator {
    if (!(publicKey instanceof Uint8Array) || publicKey.length !== 32) {
        throw new RegistrySignatureError("Registry public key must be 32 bytes");
    }
    const key = Uint8Array.from(publicKey);
    const creator: TxCreator<[]> = async (payload, _options, bindings, mocked) => {
        const metadata = unifyMetadata(decAnyMetadata(payload.context.metadata));
        const { extrinsic } = metadata;
        if (!extrinsic.version.includes(4) || (payload.txExtVersion ?? 0) !== 0) {
            throw new RegistryLayoutError(
                "Registry requires native signed V4, extension version 0",
            );
        }
        if (!("address" in extrinsic) || !("signature" in extrinsic)) {
            throw new RegistryLayoutError(
                "Registry metadata must expose address and signature types",
            );
        }
        const lookup = getLookupFn(metadata);
        const address = lookup(extrinsic.address);
        const signature = lookup(extrinsic.signature);
        if (
            address.type !== "enum" ||
            address.value.Id?.type !== "lookupEntry" ||
            address.value.Id.idx !== 0 ||
            address.value.Id.value.type !== "AccountId32"
        ) {
            throw new RegistryLayoutError(
                "Registry requires MultiAddress::Id(AccountId32) at index 0",
            );
        }
        if (
            signature.type !== "array" ||
            signature.len !== 64 ||
            signature.value.type !== "primitive" ||
            signature.value.value !== "u8"
        ) {
            throw new RegistryLayoutError(
                "Registry requires a bare 64-byte Ed25519 signature layout",
            );
        }
        const pipeline = extrinsic.extensionsByVersion[0];
        // Common enhancers append explicit custom values after their defaults.
        // The caller's override wins; duplicate input identifiers are rejected
        // before invoking those enhancers below.
        const values = new Map(payload.extensions.map((extension) => [extension.id, extension]));
        if (
            values.size !== pipeline.length ||
            pipeline.some(({ identifier }) => !values.has(identifier))
        ) {
            const expected = new Set(pipeline.map(({ identifier }) => identifier));
            const missing = pipeline
                .filter(({ identifier }) => !values.has(identifier))
                .map(({ identifier }) => identifier);
            const unexpected = [...values.keys()].filter((identifier) => !expected.has(identifier));
            throw new RegistryLayoutError(
                `Registry extensions differ: missing ${missing.join(",")}; unexpected ${unexpected.join(",")}`,
            );
        }
        const extra = pipeline.map(({ identifier }) => fromHex(values.get(identifier)!.extra));
        const implicit = pipeline.map(({ identifier }) =>
            fromHex(values.get(identifier)!.additionalSigned),
        );
        const call = fromHex(payload.callData);
        const preimage = mergeUint8([call, ...extra, ...implicit]);
        const bytes =
            preimage.length > 256 ? await firstValueFrom(bindings.hasher(preimage)) : preimage;
        const signed = mocked ? new Uint8Array(64) : await sign(bytes);
        if (!(signed instanceof Uint8Array) || signed.length !== 64) {
            throw new RegistrySignatureError(
                "Registry signing callback must return 64 Ed25519 bytes",
            );
        }
        const body = mergeUint8([
            extrinsicFormat.enc({ version: 4, type: "signed" }),
            new Uint8Array([0]),
            key,
            signed,
            ...extra,
            call,
        ]);
        return toHex(mergeUint8([compact.enc(body.length), body]));
    };
    const enhanced = withNonce(key)(withCommonExtensions(creator));
    const checked: typeof enhanced = async (payload, options, bindings, mocked) => {
        if (new Set(payload.extensions.map(({ id }) => id)).size !== payload.extensions.length) {
            throw new RegistryLayoutError("Registry extension identifiers must not be duplicated");
        }
        return enhanced(payload, options, bindings, mocked);
    };
    return Object.assign(checked, {
        publicKey: key,
        signBytes: getSignBytes(sign),
    });
}
