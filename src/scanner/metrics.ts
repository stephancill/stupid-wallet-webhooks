/** Per-chain counters accumulated in memory and written at most once per minute. */
export type ScannerMetrics = {
  scans: number;
  processedBlocks: number;
  blockItems: number;
  bloomPositiveBlocks: number;
  logItems: number;
  transferLogs: number;
  transactions: number;
  receiptItems: number;
  blockBatches: number;
  logBatches: number;
  blockAttempts: number;
  logAttempts: number;
  failedAttempts: number;
  blockAttemptedItems: number;
  logAttemptedItems: number;
};

export function emptyScannerMetrics(): ScannerMetrics {
  return {
    scans: 0,
    processedBlocks: 0,
    blockItems: 0,
    bloomPositiveBlocks: 0,
    logItems: 0,
    transferLogs: 0,
    transactions: 0,
    receiptItems: 0,
    blockBatches: 0,
    logBatches: 0,
    blockAttempts: 0,
    logAttempts: 0,
    failedAttempts: 0,
    blockAttemptedItems: 0,
    logAttemptedItems: 0,
  };
}

/** Keep this positional order in sync with docs/implementation-notes.md queries. */
export function writeScannerMetrics({
  dataset,
  chainId,
  metrics,
}: {
  dataset: AnalyticsEngineDataset;
  chainId: number;
  metrics: ScannerMetrics;
}): void {
  dataset.writeDataPoint({
    blobs: ["v2", String(chainId)],
    indexes: [String(chainId)],
    doubles: [
      metrics.scans,
      metrics.processedBlocks,
      metrics.blockItems,
      metrics.bloomPositiveBlocks,
      metrics.logItems,
      metrics.transferLogs,
      metrics.transactions,
      metrics.receiptItems,
      metrics.blockBatches,
      metrics.logBatches,
      metrics.blockAttempts,
      metrics.logAttempts,
      metrics.failedAttempts,
      metrics.blockAttemptedItems,
      metrics.logAttemptedItems,
    ],
  });
}
