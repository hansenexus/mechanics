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
