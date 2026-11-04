# 009 Subagents and presets

A worker runs under an agent preset: `dsh-superagent-worker`, `dsh-superagent-worker-docs`, or one the operator writes. A worker may also delegate to subagents. This document records how a subagent's preset is chosen, because that choice decides whether a restricted preset really restricts anything.

## What the preset is for

The roster in `assignees:v1` gives each agent a `preset`. It is the only lever that changes a worker's **capabilities**; `model` changes how well it thinks, `concurrency` changes how many tickets it may hold. A documentation worker uses `dsh-superagent-worker-docs`, which leaves out the shell tools, so it can edit files and report but cannot run commands.

That only holds if the tools it can reach are the tools its preset lists.

## How a subagent's preset is chosen

`@deepseek-ai/dsh-tool-subagent` takes two config keys that matter here:

```yaml
- id: tool-subagent
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    agentPreset: standard          # pins every child to this preset
    allowedAgentPresets: [...]     # optional: presets the model may pick from
```

Its own model-facing text states the rule (`node_modules/@deepseek-ai/dsh-tool-subagent/lib/index.js`, the `description` getter):

> "Agent preset for this child. **Omit to inherit the parent agent's current preset.**" — when `agentPreset` is unset.
>
> "Omit to use `standard`." — when `agentPreset` is set.

So inheritance is a supported behaviour, not something missing from DeepSeek Harness. A child inherits its parent's preset when the tool is mounted **without** `agentPreset`, and is pinned otherwise.

## What this repository did, and what it cost

`cordis.patch.yml` mounted `tool-subagent` with `agentPreset: standard` (line 111 at the time of writing). Every worker therefore delegated into a `standard` child — which **has** a shell — regardless of the parent's preset.

Observed on 2026-11-04: the `docs-scribe` worker, whose preset has no shell, produced PR #70 through subagents. Its session recorded 13 `subagent` calls and no shell of its own; the child sessions ran the commands. A restricted worker had escalated itself by delegating.

## The two ways to close it

**A. Pin nothing (inheritance).** Remove `agentPreset` from `tool-subagent` in the preset that must not regrow a shell. Children then compose with the parent's preset. This is the general fix: a restriction stays a restriction, whatever preset the operator writes.

**B. Remove delegation.** Do not mount `tool-subagent` in that preset at all. Done for `dsh-superagent-worker-docs` in PR #76; the preset now has no shell, no background jobs and no subagents.

B is what the repository ships today, because it is local to one preset and needs no change to how children are created. A is still the better answer for any future preset that keeps delegation: see the follow-up below.

## Follow-up: inherit instead of pin

The remaining work, in order:

1. In `cordis.patch.yml`, drop `agentPreset: standard` from the `delegation` group of `dsh-superagent-worker-preset` (line 111). Children then inherit the worker preset, whose tool set is already the intended one.
2. Re-check `modelSelection` / `modelDiscovery` in the same config: they stay valid, but a child that inherits the parent's preset also inherits its model unless the tool overrides it.
3. Decide what **permission** a subagent gets. It is not inherited today — see below.
4. Confirm with a live run: give a `docs-scribe` ticket that needs delegation, then read the child session's `agent-preset/selected` event and check whether shell tools are advertised.

## A subagent's permissions are not inherited

`src/app/sessions.ts` sets `danger-full-access` on the worker's own session. A subagent session looked the same when checked on 2026-11-04, but not because anything propagated: `@deepseek-ai/dsh-permission-presets` pins a *fresh* session to the deployment's own default (`lib/index.js`, `pinInitialPermission`):

```js
const name = this.ctx.shell.sandboxMode === "danger-full-access" ? "danger-full-access" : this.defaultPreset;
```

On this machine the shell sandbox mode is `danger-full-access`, so the default happens to equal what the worker was given. Two consequences:

- **The match is a coincidence of configuration, not a rule.** Narrowing the deployment's sandbox mode makes a child *stricter* than its parent: the worker keeps the explicit `danger-full-access`, the child falls back to `defaultPreset` and starts asking for approval on work its parent could do. The symptom is a subagent that stalls, with nothing on the ticket explaining why.
- **That line is a local patch.** The same directory keeps `lib/index.js.dshpurge.bak`; the original reads `const name = this.defaultPreset;`, and the comment on the neighbouring line says the official approval teaching was removed. Upgrading DeepSeek Harness replaces this file, so the behaviour can change without anything in this repository changing.

If the deployment ever runs with a narrower sandbox, set the child's permission explicitly after creating it rather than relying on the default, or accept that subagents are stricter and say so in the preset's description.

Nothing in the Engine has to change; the preset an agent runs under already travels with the ticket (`ticket.execution.assignee`), so the roster stays the single place that decides capabilities.

## Why this is written down

The rule that a preset decides capability is easy to state and easy to defeat by accident: one pinned key is enough. Recording the mechanism and the fix keeps the next preset from quietly reopening it.
