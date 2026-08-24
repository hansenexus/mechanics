---
name: mechanics-verify
description: Run a mechanics verification wave for an app — execute the linked specs through the app's harness, drive a browser against acceptance criteria for agent-method mechanics, print the manual checklist for destructive ones, and merge evidence into the wave file. Trigger phrases "mechanics-verify <app> <wave>", "run the wave", "verify mechanics", "verify the baseline".
---

# mechanics-verify — execute a verification wave

Fills a wave file (`<corpus>/waves/<wave>.yaml`) with evidence: per-mechanic
`pass` / `fail` / `n-a` entries. **The committed wave file IS the verification
record.** CI never runs this — you do, against a live dev server.

`<corpus>` is `mechanics/` in a single-app repo and `<appsDir>/<app>/mechanics/`
in a multi-app one; `mechanics.config.yaml` decides. Never hardcode either.

## Inputs

- `$1` app slug · `$2` wave slug. The wave file must exist; create one from the
  reference template if starting fresh, setting `baselineSha` and `scope`.
- `--method e2e|agent|manual` (filter) · `--only <id,…>` · `--resume` (skip
  entries that already have a verdict).

## Preflight

1. `mechanics check --app=$1` must be green. Fix the corpus first, not here.
2. The app's dev server is running, and you know its base URL.
3. The harness the wave needs is actually available — a spec runner, a browser
   driver, whatever credentials the app's login flow requires. **If something
   is missing, SKIP that method's mechanics (leave them pending), report the
   gap, and continue with what is runnable.** Never fabricate evidence; a wave
   is only worth keeping if every green entry in it was earned.

## Execution order

1. **e2e** — `mechanics verify --app=$1 --wave=$2 [--only…] [--resume]`.
   The CLI dedupes specs across mechanics, runs each once through the
   configured runner, ANDs the verdicts per mechanic, and merge-writes the wave
   YAML. It never overwrites a standing `manual` or `agent` entry.
2. **agent** — for mechanics the CLI reports as agent-method: sub-agents in
   batches of ~8, each given one mechanic's acceptance criteria, the base URL
   and the app's login flow. Drive the browser criterion by criterion; the
   mechanic passes only if EVERY AC passes. Record each result:

   ```
   mechanics verify --app=$1 --wave=$2 --set <id>=<pass|fail> \
     --method=agent --evidence="<screenshot path or note>" --by=<agent-name> \
     [--note="AC<n>: what failed"]
   ```

3. **manual / destructive** — print the checklist. `destructive: true` is an
   ABSOLUTE block on auto-driving (kill switches, deploys, restarts, DNS, token
   rotation) even when a `verify:` hint says otherwise. A human checks and
   records with `--method=manual`. `n-a` with an evidence note is the honest
   state for "not safe to verify right now" — far better than a guess.

## Wrap-up

1. `mechanics check --app=$1` validates the wave file and the closed-wave
   invariant; `mechanics coverage --app=$1` prints the rollup. For something to
   hand a human, `mechanics report --html`.
2. Commit on a branch (`mechanics/verify-$1-$2`) and open a PR through whatever
   this project uses — a dedicated skill, the platform CLI, or leave the branch
   pushed and say so. Put the summary table and the failure list in the body.
3. Failures stay `fail`. Spec bugs found while verifying are fixed in SEPARATE
   pull requests — never edit mechanic files from this skill — then re-run with
   `--only=<failed ids>`.

## Guardrails

- Propose only. Never auto-merge. Never close the wave: flipping
  `status: closed` is a human edit, made once nothing in scope is
  pending / fail / blocked.
- Never write `pass` without an evidence string. The CLI refuses, and so should
  you.
- Never verify against production. Dev or staging only.
