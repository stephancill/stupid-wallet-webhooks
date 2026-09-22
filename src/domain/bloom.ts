import { keccak256, pad, type Hex } from "viem";
import { z } from "zod";
import { TRANSFER_TOPIC } from "./activity";

export const logsBloomSchema = z.string().regex(/^0x[0-9a-fA-F]{512}$/);
const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

/** The three bloom bits selected by the first six bytes of keccak256(value). */
function bloomMask({ value }: { value: Hex }): bigint {
  const hash = keccak256(value);
  let mask = 0n;
  for (let offset = 2; offset < 14; offset += 4) {
    const bit = Number.parseInt(hash.slice(offset, offset + 4), 16) & 2047;
    mask |= 1n << BigInt(bit);
  }
  return mask;
}

const transferMask = bloomMask({ value: TRANSFER_TOPIC });

export type TransferBloomFilter = { addressMasks: readonly bigint[] };

/** Precompute once per tracked-set snapshot, rather than hashing every block. */
export function createTransferBloomFilter({
  trackedAddresses,
}: {
  trackedAddresses: Iterable<Hex>;
}): TransferBloomFilter {
  return {
    addressMasks: [...trackedAddresses].map((address) =>
      // Transfer participants are 32-byte indexed topics, not 20-byte emitters.
      bloomMask({ value: pad(addressSchema.parse(address) as Hex, { size: 32 }) }),
    ),
  };
}

/** A negative is conclusive; a positive still requires an exact-hash log read. */
export function mayContainTrackedTransfer({
  logsBloom,
  filter,
}: {
  logsBloom: Hex;
  filter: TransferBloomFilter;
}): boolean {
  const bloom = BigInt(logsBloomSchema.parse(logsBloom));
  return (
    (bloom & transferMask) === transferMask &&
    filter.addressMasks.some((mask) => (bloom & mask) === mask)
  );
}
