---
title: docket/1
description: The run protocol — work orders with checkable exit criteria and an append-only event log.
---

`docket/1` is the format mechanics uses to track agent work: a work order with
phases and exit criteria, an append-only event log, and a derived state file.

It is **a file format, not a service**. No daemon, no database, no account. A
run is a directory under `.docket/`, and everything about it is committed
alongside the code it describes.

The [specification](https://github.com/hansenexus/mechanics/blob/main/spec/docket-1.md)
ships in the package with
[executable conformance vectors](https://github.com/hansenexus/mechanics/blob/main/spec/docket-1.vectors.json),
so another implementation can prove it agrees rather than assert it.

## The commands

```bash
mechanics run list [--watch]                   # the board
mechanics run new --title="…"                  # open a work order
mechanics run event --run=<id> --type=<type>   # append to the event log
mechanics run show --run=<id>                  # phases, criteria, evidence
mechanics run rebuild --run=<id> | --all       # regenerate state.json from events
mechanics run proposals --run=<id>             # what is queued for review
mechanics run accept --run=<id> --proposal=<id> [--apply]
mechanics run reject --run=<id> --proposal=<id> --reason=…
```

## Decision records

`.docket/decisions/<id>.md` — an ADR whose job is to **reach the next agent**,
not to sit in a folder.

```markdown
---
status: accepted
date: 2026-08-24
decidedBy: [lennard]
run: 2026-08-24-monitor-rewrite
affects:
  specs: [perch.monitors]
  paths: ["convex/monitors.ts", "src/workers/*.ts"]
---

## Context

## Decision

## Rationale

## Consequences
```

Four fixed H2 sections, in that order. `status` is `proposed`, `accepted`,
`superseded` or `rejected`. The id comes from the filename and is **refused** in
frontmatter — the same rule mechanic ids follow, because two sources of truth
for a name is how a rename silently forks a record.

### `affects` is the whole design

`affects.paths` is a resolvable claim, exactly like a behaviour's `paths:`. That
makes a decision **retrievable by the thing an agent is about to touch** — the
only retrieval key that works when the agent does not yet know the question.
*Why is this like this* is unanswerable by search, because the agent would have
to already suspect there was a reason. A glob resolved against the file in hand
needs no such suspicion. This is what `mechanics_decisions({path})` over
[MCP](/mcp/) queries.

### Staleness is an error, not a warning

An `accepted` record whose `affects.paths` matches no files points at code that
no longer exists, and `mechanics check` fails on it. A decision about deleted
code is worse than no decision: it is confident, committed, and wrong, and the
next agent has no way to tell. Supersede it or reject it — both are one-line
edits, and both leave the reasoning readable.

Two exemptions, and both are deliberate:

- Only `accepted` is held to the rule. A `proposed` record may legitimately
  point at code that is not written yet.
- An empty `paths` list makes no resolvable claim, so there is nothing to have
  gone stale. Erroring there would punish a spec-scoped decision for being
  honest about its scope.

### Supersession replaces deletion

`supersedes` forms a chain, and a superseded record stays on disk. Deleting the
old record deletes the reason the new one exists, which is exactly the context a
later reader needs in order not to re-litigate a settled question. Two more
rules fall out of the same lifecycle: `supersedes` naming a record that is not
there is an error, and so is a superseded record still marked `accepted`.

### Conflict detection

Two *open* runs whose decisions' `affects` overlap get flagged. This is the
characteristic multi-agent failure and it is invisible from inside either run,
because each one looks locally coherent. Path overlap resolves through the real
file list rather than by comparing glob strings — `src/**` and
`src/lockers/*.ts` are textually unrelated and cover the same code — and spec
ids match hierarchically, so a broad decision and a narrow one, the pair most
likely to conflict, are caught.

It is a **warning, not an error**, and the asymmetry is deliberate. A stale
record is a defect only the folder's owner can fix; two open runs touching one
subsystem is a legitimate state that resolves when one of them lands. Failing CI
on it would punish concurrency, which is the thing the run layer exists to
enable.

### Not a fourth way round the refusals

A decision record is a written argument, not a verdict. It grades nothing and
marks nothing green. `status: accepted` means *we are doing it this way*, never
*the work is done*: criteria still go through `mechanics verify` and still need
evidence, and nothing in this layer appends a `criterion.evaluated`. The MCP
tool reads records and writes none, for the same reason the server has no
`mechanics_record`.

## The event log is the source of truth

`state.json` is derived, not authoritative — `run rebuild` regenerates it from
the events at any time. That is what makes the log auditable: a state file
somebody edited by hand is detectable, because rebuilding produces a different
one.

## Proposals

When [`gaps`](/cli/#gaps) meets something with more than one correct answer, it
does not guess. It queues a proposal against a run, and a human resolves it:

```bash
mechanics run proposals --run=<id>
mechanics run accept --run=<id> --proposal=<id> --apply
mechanics run reject --run=<id> --proposal=<id> --reason="wrong area"
```

`accept` refuses any actor that is not human. Accepting asserts that a
suggestion was right, which is the same act as marking work green.

## Licence

The specification is available under **CC BY 4.0** in addition to the package's
MIT licence, so another implementation may reuse its wording with attribution.
