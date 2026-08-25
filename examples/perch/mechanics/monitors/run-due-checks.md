---
title: Run every check that has come due
kind: system
status: active
priority: p0
roles: [system]
claims:
  cron: ["run due checks"]
  worker: ["src/workers/probe-runner.ts"]
paths: ["src/workers/probe-runner.ts", "convex/crons.ts"]
nonFunctional: [perf]
destructive: false
aliases: []
verify: agent
---

## Story

As the system, I run each monitor at its configured interval so that the state
Perch reports is never older than one interval.

## Acceptance Criteria

- **AC1** Given monitors due at this tick, When the cron fires, Then each is
  probed exactly once and its result recorded.
- **AC2** Given a probe exceeds the timeout, When it is abandoned, Then it is
  recorded as a failure with reason `timeout`, not dropped.
- **AC3** Given the previous tick is still running, When the next fires, Then
  it skips monitors already in flight rather than probing them twice.
- **AC4** Given a batch partially fails, When the tick ends, Then successful
  results are still recorded.

## Edge Cases

- A monitor whose interval is shorter than its own response time is probed
  serially, never concurrently with itself.
- Clock skew that makes a check appear due twice yields one probe, because
  due-ness is claimed transactionally.

## Error States

- Probe pool exhausted: due checks queue rather than fail, and a `probe backlog`
  warning surfaces once the queue exceeds one interval.

## Non-functional

- perf: a tick of 1000 due monitors dispatches within 5s of the cron firing.
