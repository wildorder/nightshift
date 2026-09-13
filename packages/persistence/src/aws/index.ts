/**
 * DynamoDB and S3 adapters — **built in P2, not P1**.
 *
 * P1 defines the ports (`@nightshift/core`) and the in-memory adapter
 * (`@nightshift/persistence/memory`). This module exists so the subpath export
 * and the architecture rule that guards it are in place and under test before
 * there is anything behind them.
 *
 * When P2 fills this in, it must pass the same conformance suite the memory
 * adapter passes, unchanged.
 */
export {};
