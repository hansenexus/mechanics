# CLAUDE.md

Conventions for agents working in this repo. The README is the product pitch and
`spec/docket-1.md` is the protocol; this file is the part that is not obvious from
either, plus the small set of things that must not be "improved".

## Commands

```bash
bun install --frozen-lockfile   # bun ≥ 1.2; the lockfile is committed
bun run lint                    # biome check .
bun run typecheck               # tsc --noEmit
bun run test                    # vitest run
bun run build                   # bundle dist/cli.js (node target) + banner
bun run docs:shots              # regenerate docs/images/* from examples/perch
```

`lint`, `typecheck`, `test` are exactly CI's `check` job — run all three before
pushing. CI adds two more gates that are easy to break without noticing locally:
`tarball` packs the package, installs it into a scratch consumer and drives
`template/` through the **installed** CLI, and `dist` proves `dist/cli.js` starts
under plain `node`. Anything that works under Bun but not Node, or that lives
outside the `files` allowlist in `package.json`, fails there and nowhere else.

The `site/` Astro build is a separate workspace with its own `bun.lock` and its own
workflow. `cd site && bun install && bun run build`.

## Layout

Source is **flat at the repo root** — `parser.ts`, `coverage.ts`, `docket-*.ts` —
with each module's tests beside it as `<module>.test.ts`. Vitest only collects
`*.test.ts` at the root, so a test in a subdirectory silently never runs.

Adding a module means three edits, not one: the file, its test, and the `exports`
map in `package.json`. A module missing from `exports` is unreachable for
consumers even though every local import still resolves.

`index.ts` is the read-only barrel the console dashboard imports. Keep process
spawning and repo-wide walks out of it — they belong in `manifest.ts` / `verify.ts`,
so a Next server component importing the barrel does not pull them in.

| Path | What it is |
|---|---|
| `template/` | what `mechanics init` writes; the tarball smoke drives this |
| `examples/perch/` | a mid-life corpus with four deliberate gaps; the screenshots are pictures of it |
| `fixtures/repo/` | synthetic trees for unit tests |
| `spec/` | the docket/1 spec and its executable conformance vectors |
| `plugin/` | three Claude Code skills (init, verify, gaps) |
| `site/` | Astro + Starlight, deploys to mechanics.hansenexus.dev |

`template/`, `examples/`, `fixtures/` and `site/` are excluded from biome — they are
inputs to tests, not sources, so do not "fix" their style. The two exclusion lists do
not line up: tsc still covers `template/` and `fixtures/` (only `examples/` and `site/`
are out), so a type error there fails `typecheck` while lint stays silent about it.

## The refusals — do not weaken these

They are the product, not safety theatre, and each is pinned by a test that exists
to fail when someone relaxes it. Treat a request to loosen one as a conflict to
raise, not a task to do.

1. **The MCP server is read-only.** `mcp.test.ts` asserts no write-shaped tool name
   is advertised. Adding a write tool defeats the point of serving a corpus to an
   agent at all.
2. **`pass` requires evidence** — checked at write time and again at read time, so a
   hand-edited log cannot slip one through (`docket-events.ts`).
3. **Only a human may accept a proposal.** `docket-events.test.ts` walks every actor
   kind as a table, and `ci` is refused alongside the agent kinds on purpose.
   `proposals.ts` must not become a way around the check it wraps.
4. **Four edits a provider may never make** (`forbiddenEdit` in `autofix.ts`): a wave
   file, promoting `status: draft` to `active`, `coverage.ignore`, and
   `coverage.enforce`. Those are claims that the work is good, not the work.

The actor check infers `human` from the *absence* of an agent session variable. That
is a default path, not a boundary — say so plainly if it comes up rather than
overclaiming it.

## Corpus and example invariants

`examples.test.ts` asserts perch's gaps **exactly**, because an accidental gap is how
the README ends up advertising a coverage number nobody chose. If you change perch,
expect that test to fail, and regenerate the screenshots with `bun run docs:shots` —
`docs/images/*.png` are the real CLI's real output and go stale silently otherwise.

`docket-conformance.test.ts` runs `spec/docket-1.vectors.json` from the serialized
wire lines. Changing the event format means changing the spec, the vectors and the
implementation together; the vectors are what a second implementation builds against.

**13 skipped tests is the normal result.** `mcp.test.ts` gates itself on a `console`
manifest that this repo does not carry, and `screens.test.ts` does the same. Skipped
is not passing — if you touched the MCP server, drive it through the template smoke.

## Style

Comments here explain **why**, in prose, and are often several lines — see the
headers on `layout.ts`, `autofix.ts` or any workflow in `.github/workflows/`. That is
the house style; match it. A comment restating what the line does is noise, but the
reason a constraint exists is the thing worth keeping. The same applies to commit
bodies: conventional-commit subject, then the reasoning.

`biome.json` is the authority on formatting (100 cols, double quotes, semicolons, ES5
trailing commas). `any` and non-null assertions are errors, not warnings.

## Git and releases

Branch off `main`, push to **GitHub only** — `forge.hansenexus.dev` is a read-only
mirror whose nightly sync force-wipes anything pushed to it. Open a PR; do not merge
without being asked.

Releases publish from CI over npm Trusted Publishing on a `v<version>` tag. Two
things are load-bearing and unobvious: the tag must match `package.json` (the
workflow refuses otherwise), and the *filename* `release.yml` is registered with npm
as the trusted publisher — renaming or moving the job breaks publishing until npm's
setting is updated to match. There is no token.

## orca.yaml

The committed `orca.yaml` is what bootstraps every Orca lane on this repo. Orca's
`parseOrcaYaml` returns `null` on any YAML error and then runs **no hooks at all**,
silently, so validate after any edit with Orca's own parser:

```bash
hn-infra/scripts/orca/check-orca-yaml.sh <worktree>/orca.yaml
```

`orca repo show --json` is not a check — it reads empty whether the file is perfect
or unparseable.
