---
title: "Cursor model listing"
version: 3.8.50
lastUpdated: 2026-08-09
---

# Cursor model listing

## Live catalog is exclusive when synced

After a successful Cursor model sync (`cursor-agent --list-models` → persisted
synced catalog), the **dashboard**, **`/v1/models`**, and **Test All** list:

1. Models returned by the live sync
2. Injected auto-router ids: `auto`, `auto-cost`, `auto-balance`, `auto-intelligence`
3. Operator **custom** models (Import / manual) — never pruned by sync

The large static registry under
`open-sse/config/providers/registry/cursor/` is **offline fallback only**. When
synced is empty (or discovery fails), listing falls back to that registry.

Effort-suffixed ids (for example `claude-4.6-sonnet-high`) may still be
**requested** at runtime: `resolveRequestedModel` strips the suffix into a wire
`ModelParameter`. Exclusive listing intentionally hides those static variants
from Test All so probes match what Cursor actually returns as available.

## Helpers

- `providerUsesExclusiveSyncedListing("cursor"|"cu")` —
  `src/lib/providers/modelListingCapability.ts`
- `mergeProviderModelListing` — dashboard merge
- `ensureCursorAutoCatalogEntry` — auto* inject on discovery + listing
- `shouldSuppressStaticModelForExclusiveListing` — `/v1/models` static loop
