import { z } from "zod";
import { logsBloomSchema } from "../domain/bloom";

const hashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
export const quantitySchema = z.string().regex(/^0x[0-9a-fA-F]+$/);
const indexSchema = quantitySchema.pipe(
  z.string().refine((value) => BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER)),
);

export const rpcResponseSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: z.union([z.number(), z.string(), z.null()]),
    result: z.unknown().optional(),
    error: z
      .object({ code: z.number().int(), message: z.string(), data: z.unknown().optional() })
      .optional(),
  })
  .refine(
    (response) =>
      (Object.hasOwn(response, "result") && response.result !== undefined) !==
      (response.error !== undefined),
    "Expected exactly one of result or error",
  );

export const rpcBatchResponseSchema = z.array(rpcResponseSchema);

export const rpcTxSchema = z.object({
  hash: hashSchema,
  transactionIndex: indexSchema,
  from: addressSchema,
  to: addressSchema.nullable(),
  nonce: quantitySchema,
  value: quantitySchema,
});

export const rpcBlockSchema = z.object({
  number: quantitySchema,
  hash: hashSchema,
  parentHash: hashSchema,
  timestamp: indexSchema,
  logsBloom: logsBloomSchema,
  transactions: z.array(z.union([rpcTxSchema, hashSchema])),
});

export const rpcLogSchema = z.object({
  address: addressSchema,
  topics: z.array(hashSchema),
  data: z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/),
  logIndex: indexSchema,
  transactionHash: hashSchema,
  blockHash: hashSchema,
  removed: z.literal(false).optional(),
});

export const rpcLogsSchema = z.array(rpcLogSchema);

export const rpcReceiptSchema = z.object({
  transactionHash: hashSchema,
  blockHash: hashSchema,
  status: quantitySchema.pipe(
    z.string().refine((value) => BigInt(value) === 0n || BigInt(value) === 1n),
  ),
  contractAddress: addressSchema.nullable(),
});

export function rpcReadError({ message, cause }: { message: string; cause?: unknown }): Error {
  return Object.assign(new Error(message, { cause }), { name: "RpcReadError" });
}

export function isRpcReadError(error: unknown): boolean {
  return error instanceof Error && error.name === "RpcReadError";
}

export function parseRpcData<T>({
  schema,
  value,
  context,
}: {
  schema: z.ZodType<T>;
  value: unknown;
  context: string;
}): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw rpcReadError({
      message: `Invalid RPC ${context}: ${result.error.message}`,
      cause: result.error,
    });
  }
  return result.data;
}
