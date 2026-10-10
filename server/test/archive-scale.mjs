// Observational contract: growing owner work is data, not a failing performance test.
export const measurementContract = Object.freeze({
  schemaVersion: 1,
  historicalEntrySizes: [0, 20, 100, 500],
  samplesPerSurface: 1,
  surfaces: ['getSession', 'acceptedSend', 'contextAssembly', 'completedSnapshot'],
  sqlCoverage: 'Domain-port methods only; returned rows, not scanned rows or whole-Store totals',
  desiredTarget: 'snapshot independent of unrelated history; budget-bounded context materialization with classification/provenance preserved',
});
