# 0. Record architecture decisions

Date: 2026-05-18

## Status

Accepted

## Context

We need to record the architectural decisions made on this project as it grows. Decisions that are non-trivial, that constrain future work, or that imply tradeoffs should be captured so that contributors (human and agent) can understand the reasoning behind the current shape of the code without having to reconstruct it from commits.

## Decision

We will use Architecture Decision Records (ADRs), as described by Michael Nygard, stored as plain markdown files in `docs/adr/`.

Each ADR is numbered sequentially. Once accepted, ADRs are immutable — superseding decisions are recorded as new ADRs that mark the previous one as `Superseded`.

## Consequences

- Future contributors can scan `docs/adr/` to understand why the code looks the way it does
- Each non-trivial decision becomes a discoverable, citable artifact
- Reversing a decision costs at least one new ADR — this is intentional friction
