import { describe, expect, it } from "bun:test";
import {
  normalizeAddressInput,
  addressBlobToHex,
  AddressValidationError,
} from "../src/domain/address";

const CHECKSUM = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

describe("address normalization", () => {
  it("checksums lowercase input and round-trips to hex", () => {
    const normalized = normalizeAddressInput("0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266");
    expect(normalized.hex).toBe(CHECKSUM);
    expect(addressBlobToHex(normalized.blob)).toBe(CHECKSUM);
  });

  it("treats identity as case-insensitive", () => {
    const a = normalizeAddressInput(CHECKSUM);
    const b = normalizeAddressInput("0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266");
    expect(a.hex).toBe(b.hex);
    expect(a.hex).toBe(CHECKSUM);
    expect(Buffer.compare(Buffer.from(a.blob), Buffer.from(b.blob))).toBe(0);
  });

  it("rejects invalid addresses", () => {
    expect(() => normalizeAddressInput("0x1234")).toThrow(AddressValidationError);
    expect(() => normalizeAddressInput("not-an-address")).toThrow(AddressValidationError);
  });
});
