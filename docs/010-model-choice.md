# 010 Choosing a model for an agent

The roster gives each agent a `model`. Nothing in the repository said which model suits which work, so the first roster
gave the expensive model every implementation task and the cheap one everything else. This note records the measurement
that changed that, and what it does and does not show.

## The question

Does a more expensive model produce a better patch for a small, clearly described defect?

## The experiment

Two defects were filed twice, once per arm. Each arm ran the same task text, the same preset, and the same repository
state, and differed only in the roster entry the routing picked:

| | Arm A | Arm B |
| --- | --- | --- |
| Model | `deepseek-flash` | `deepseek-v4-pro` |
| Preset | `dsh-superagent-worker` | `dsh-superagent-worker` |
| Tasks | roster `scopes` case sensitivity; a `work_type` silently dropped off `accept` | identical |

Both arms produced a pull request per task, all four of which passed `pnpm check` in CI.

## Result

| Task | Arm A (flash) | Arm B (pro) |
| --- | --- | --- |
| `scopes` case sensitivity | +17 / −3, 3 files | +17 / −3, 3 files |
| `work_type` off `accept` | +41 / −5, 2 files | +41 / −5, 2 files |

Comparing the patches line by line:

- Task 1: **identical**.
- Task 2: **four lines differ**, and all four are one comment wrapped differently.

Both arms found the same fix (reuse `sameName` for scopes; refuse the field and name the kind that reads it), added
tests, and updated the README where behaviour is described.

## What this changes

`bugfix` now routes to the cheap model. `refactor` still routes to the expensive one, because nothing has measured it
yet. Before this, every implementation ticket paid for the expensive model to produce the patch the cheap one produced.

## What this does not show

- **Two tasks, one each.** A single result per arm cannot separate the model from the task.
- **Both tasks were small and precisely described.** The description named the symptom, the expected behaviour and the
  file area. A defect that needs diagnosis before it can be fixed is a different experiment.
- **Same family.** `deepseek-flash` is a cheap model, not a weak one: it still reads the repository, runs the tests and
  writes the same comment style. The result says nothing about replacing it with a model of another family.

A useful next measurement is a task with an unstated cause: give the symptom only, and compare how often each arm finds
the defect at all. That separates "writes the same patch" from "finds the same patch".

## Reproducing it

1. Set the roster so one work type reaches one arm, and file the tasks.
2. Record each pull request's diff, CI result and file list; compare the patches, not the sizes.
3. Switch the roster and file the same tasks again. The Router refuses a request it can see a fix for, so the second arm
   needs the first arm's pull requests closed, and the task text has to say it is a re-run — see [003 Execution](003-execution.md)
   for why a duplicate request gets ignored rather than accepted.
4. Put the roster back.

Two things to watch when running it: a task text that names the work type makes the routing result uninteresting (the
model reads the type instead of inferring it), and the polling cursor can step over an Issue you open yourself, which
`fix: read an Issue the polling cursor stepped over` closes.
