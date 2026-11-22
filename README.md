# mend: one patch tool for every AI edit format — 4 formats, 3 matching tiers, 100/100 practice checks, score 1000

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/yannyonn94/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/yannyonn94/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files. Models
write edits in four formats, and each public applier reads one of them. `mend`
reads all four to one written contract (`SPEC.md`): a unified diff (often with
wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and
text-editor tool calls as JSON. It finds the lines an edit names even when the
model drifted their whitespace or indentation, and changes every file or none.

## How it wins

- **Three matching tiers.** Every old-lines block is matched at the first tier
  where it occurs: tier 0 exact, tier 1 trailing whitespace ignored, tier 2
  leading and trailing whitespace ignored, with tier-2 new lines re-indented
  to the file's own indentation. The house baseline is a strict tier-0-only
  applier; every drifted-whitespace check it fails, `mend` passes.
- **Nearest wins.** A unified hunk takes the occurrence nearest its (often
  wrong) line number; a SEARCH/REPLACE block fails `ambiguous` only when its
  old lines occur more than once at their tier; a V4A chunk walks a cursor
  from its anchor, so repeated blocks apply in order.
- **All or nothing.** Edits apply in patch order to the tree as earlier edits
  left it; a failed edit changes nothing, the edits after it still run, every
  failure is reported, and when any edit failed no file is written.
- **Exact about bytes.** CRLF files keep CRLF, files without a final line
  break keep none, `\ No newline at end of file` is honoured, moves print
  one `R old -> new` line, and a file whose bytes did not change is not
  listed.

## Usage

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `PATCH` is the patch file, relative to the working directory; absent or `-`
  reads the patch from standard input.
- `--format=NAME` reads one format: `unified`, `search-replace`, `v4a`,
  `json`; `auto` (the default) detects it.
- `--check` does everything but write: the same output and exit code, no
  file created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).
- Options and `PATCH` may come in any order; `--` ends the options.

Exit 0 lists each changed path (`A`, `D`, `M`, `R old -> new`) then
`ok: <n> files`. Exit 1 lists one `error: <code> <path>` line per failed edit
(`no-match`, `ambiguous`, `missing`, `exists`, `unsafe`) then
`failed: <k> of <n> edits`, and writes nothing. Exit 2 is a usage, missing
patch, format or parse error, one line, nothing written.

## Files

- `main.ts` — the CLI, Node 22 and its standard library alone (900 lines).
- `runner.ts` — the kit's runner, kept as it is; a trial hands over to it.
- `check.ts` — the practice set on your own machine.
- `SPEC.md` — the whole specification.
- `LICENSE` — MIT.

## Design notes

Three approaches were considered before building: (1) a strict tier-0-only
applier — the house baseline, which ties it at best and never beats it;
(2) full three-tier matching with anchor-nearest unified hunks and cursor
V4A chunks; (3) variant 2 plus exhaustive edge handling — CRLF, no final
line break, `\` markers, ambiguous detection, unsafe paths, move output,
atomicity — verified against the whole practice set and hand-built edge
cases. Variant 3 is what ships: the concept is not a prettier diff reader,
it is a reader that never trusts the model's line numbers or whitespace.

## Verification

```sh
node check.ts <kit>/program/generator/practice.json
# 100 of 100 passed: practice score 1000
```

Local grading through the kit's own trial runner (`grade-local --driver
process`, practice trial-0): score **1000**, 100/100 checks passed
(unified 30, search_replace 20, v4a 20, json 15, cli 15), working 1,
replay reproduced byte for byte.
