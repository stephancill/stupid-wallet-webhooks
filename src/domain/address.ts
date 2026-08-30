/**
 * EVM address normalization. Addresses are validated and checksummed with viem,
 * stored as canonical 20-byte BLOBs, and returned as checksummed hex. Identity
 * is case-insensitive.
 */

import { bytesToHex, getAddress, hexToBytes, isAddress } from "viem";

export type NormalizedAddress = {
  /** Checksummed `0x` hex form, used in API responses. */
  hex: `0x${string}`;
  /** Canonical 20-byte value, used as the D1 BLOB key. */
  blob: Uint8Array;
};

export function normalizeAddressInput(raw: string): NormalizedAddress {
  const value = raw.trim();
  if (!isAddress(value)) {
    throw new AddressValidationError(value);
  }
  const checksummed = getAddress(value);
  return { hex: checksummed, blob: hexToBytes(checksummed) };
}

/** Converts a D1 BLOB column value (Uint8Array / ArrayBuffer / hex string) to checksummed hex. */
export function addressBlobToHex(blob: Uint8Array | ArrayBuffer | string): `0x${string}` {
  let uint8: Uint8Array;
  if (typeof blob === "string") {
    uint8 = hexToBytes(blob as `0x${string}`);
  } else if (blob instanceof ArrayBuffer) {
    uint8 = new Uint8Array(blob);
  } else {
    uint8 = blob;
  }
  // Re-checksum from the byte form so every response is EIP-55 checksummed.
  return getAddress(bytesToHex(uint8));
}

export class AddressValidationError extends Error {
  constructor(input: string) {
    super(`Invalid EVM address: ${input}`);
    this.name = "AddressValidationError";
  }
}
