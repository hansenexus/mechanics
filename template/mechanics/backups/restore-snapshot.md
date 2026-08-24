---
title: Restore a snapshot over a target directory
kind: user-facing
status: active
priority: p0
roles: [operator]
claims:
  cli-command: ["src/commands/restore.ts"]
paths: ["src/commands/restore.ts"]
nonFunctional: []
destructive: true
aliases: []
verify: manual-only
---

## Story

As an operator, I can restore a snapshot into a target directory so that I can
recover from data loss.

## Acceptance Criteria

- **AC1** Given a valid snapshot id, When I run `restore <id> <target>`, Then
  every file in the snapshot exists under the target with its original content.
- **AC2** Given the target already holds files not in the snapshot, When I
  restore without `--clean`, Then those files are left untouched.
- **AC3** Given `--clean`, When I restore, Then the command prints the count of
  files it will delete and requires a confirmation before proceeding.

## Edge Cases

- Restoring into a target that does not exist creates it.
- Restoring a snapshot taken on another platform normalizes path separators.

## Error States

- Unknown snapshot id: `no snapshot <id> — run 'status' to list them`, exit 2.
- Target not writable: `cannot write to <target>: permission denied`, exit 2.

## Notes

`destructive: true` — verification overwrites real files, so this mechanic is
never driven automatically. Record its verdict by hand after a human check:

```
mechanics verify --app=example --wave=<wave> \
  --set example.backups.restore-snapshot=pass \
  --method=manual --evidence="restored into a scratch dir, diffed clean" --by=<you>
```
