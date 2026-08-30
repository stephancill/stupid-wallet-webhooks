import type { MatchedMessage } from "../env";

/**
 * Enqueues matched observations onto the `matched-activity` queue, one message
 * per (chainId, transactionHash, trackedAddress) bundle. The fanout consumer
 * (on `webhook-delivery`) is Milestone 3; here we only produce.
 */
export async function enqueueMatched({
  queue,
  observations,
}: {
  queue?: Queue<MatchedMessage>;
  observations: Array<Omit<MatchedMessage, "blockNumber"> & { blockNumber: string }>;
}): Promise<void> {
  if (queue === undefined) {
    console.warn("matched-activity queue not bound; observations persisted but not enqueued");
    return;
  }
  const messages = observations.map((o) => ({
    id: `o-${o.observationId}`,
    body: {
      observationId: o.observationId,
      chainId: o.chainId,
      txHash: o.txHash,
      trackedAddress: o.trackedAddress,
      blockNumber: o.blockNumber,
      blockHash: o.blockHash,
    },
  }));
  if (messages.length === 0) return;
  await queue.sendBatch(messages);
}
