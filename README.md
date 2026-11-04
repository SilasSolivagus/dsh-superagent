# dsh-superagent

> **Research prototype for reference only, not an official DeepSeek product.** This code grew out of our team's day-to-day development work, with much of the engineering done by coding agents. Treat it as research code, not production-ready software. It may still contain bugs, and its coding style and engineering practices may be inconsistent. Review and adapt it before using it in your own environment.
>
> We have adapted it for publication, so it is not identical to our internal version or the implementation described in *Exploring Super-agent Design: Towards a More Autonomous Agent System*. Some designs discussed in the article are directions for future development and are not implemented in this prototype.

dsh-superagent is a proactive coding agent for one GitHub repository, packaged as a bundle for [DeepSeek Harness](https://www.deepseek.com/en/harness/). It listens to GitHub and, optionally, Feishu. When someone allowed asks the agent for work, it opens a work item, works on it in its own agent session and directory, and answers in the original conversation, for example with a pull request. A web panel shows what needs a person.

It is also a way of working with an agent: **take as little human attention as possible, and give as much value as possible.** An agent that can act for a whole team can also waste a whole team's attention, so it acts only when asked or when a rule the team wrote allows it, and speaks only when someone must act or can use a result. [docs/000-philosophy.md](docs/000-philosophy.md) explains the principle and what it asks of the operator.

## Setup

Setup has many steps, so an agent does it with you. Ask your coding agent:

> Read SETUP.md in this repository and set up dsh-superagent with me.

It asks one short question at a time, shows the full plan once, and then installs and configures everything. [SETUP.md](SETUP.md) is what it follows.

## Assignee routing

Assignee routing decides which executor a Ticket should go to. Its configuration is not a settings block: it is the JSON record at the KV key `assignees:v1` in the state database (`<stateDir>/orchestrator.sqlite`, table `kv`). The settings schema is strict, so a build that added a routing field to settings would make an older build fail to parse the settings it reads at startup; a record in its own KV key is invisible to a build without the feature, and rolling back needs no migration.

That separation is deliberate. A settings field becomes a contract every older build must parse and every panel form must carry, which suits a value the team settles once, not a roster the prototype is still testing. Kept in its own record with its own `version`, the roster can change shape or disappear between builds and be migrated in code, and the settings blocks stay untouched.

The cost is the panel. A settings block brings a form, validation on save and a revision history; `assignees:v1` has none of them, so changing the roster means writing the record into `kv` directly. A record that fails its schema is discarded silently, so a typo shows up as the fallback to `default-worker` described below, not as a refused save.

```json
{
  "version": 1,
  "enabled": false,
  "agents": [
    { "id": "default-worker", "preset": "dsh-superagent-worker", "model": null, "skills": ["*"], "scopes": ["*"], "concurrency": 2, "cost": "mid" }
  ]
}
```

`version` must be `1`. `enabled` is the master switch and defaults to `false`. The record above is the built-in default, so it can be stored unchanged; add an entry to `agents` for each further executor. This prototype implements only shadow mode: whether it is `false` or `true`, each explicit accept records what routing would choose and the Ticket is accepted exactly as before. A missing or invalid record falls back to the single wildcard `default-worker` above.

Each agent names the work it can take:

- `skills`: work types (`copy`, `visual`, `bugfix`, `refactor`, `test`, `docs`, `infra`, `review`, `other`). `*` matches every type, but contributes only 0.25 to the rank, while naming the type contributes 1. Adding an agent that names a type can therefore be enough for routing to prefer it over the wildcard default.
- `scopes`: repositories as `owner/name`; `*` matches any. An agent whose scopes exclude the repository is not considered.
- `concurrency`: the most Tickets the agent may hold at once, from 1 to 16. A full agent is not considered.
- `cost`: `low`, `mid` or `high`; a lower cost ranks higher when the other factors are equal.

`preset` and `model` are optional overrides for the Executor Session preset and the model from the execution settings. The router writes each decision to `assignees-shadow:<decisionId>`: the work type, the chosen assignee with its score and evidence, any fallback reason, and whether `enabled` was on when the decision was made, and a `configFingerprint` of the configuration it was computed against. Comparing that fingerprint with the fingerprint of the current record answers whether an old suggestion is still explained by today's roster. A fallback names an agent that is actually in the roster: `default-worker` when present, otherwise the first agent with a `*` skill, otherwise the first agent. Its evidence records the rule (`fallback:default-worker`, `fallback:first-wildcard` or `fallback:first-agent`) and the chosen id. The KV keeps only the most recent 100 shadow records and prunes the oldest as new decisions are recorded, so it never grows without bound; pruning keeps the newest records by timestamp, so a record still being read is never removed.

### Reading the shadow records

The records live in the state database: rows of the `kv` table whose key starts with `assignees-shadow:`. Point `sqlite3` at that database once, filling in the state directory from the deployment configuration:

```sh
db=<stateDir>/orchestrator.sqlite
```

The latest decisions, newest first: the work type, the assignee routing suggested, and the fallback reason (empty when a candidate was ranked):

```sh
sqlite3 -header -column "$db" "
  SELECT json_extract(value, '$.at')                  AS at,
         json_extract(value, '$.workType')            AS work_type,
         json_extract(value, '$.suggestion.assignee') AS assignee,
         json_extract(value, '$.suggestion.fallback') AS fallback
  FROM kv
  WHERE key LIKE 'assignees-shadow:%'
  ORDER BY at DESC
  LIMIT 20;"
```

One `GROUP BY` counts where each work type has been landing; `(none)` means the accept named no work type:

```sh
sqlite3 -header -column "$db" "
  SELECT COALESCE(json_extract(value, '$.workType'), '(none)') AS work_type,
         json_extract(value, '$.suggestion.assignee')          AS assignee,
         COUNT(*)                                               AS decisions
  FROM kv
  WHERE key LIKE 'assignees-shadow:%'
  GROUP BY 1, 2
  ORDER BY 1, decisions DESC;"
```

These records are write-only: `recordShadow` writes one per explicit accept, nothing reads them back into the work path, and the accept continues exactly as before. The queries therefore observe what routing would decide without changing which executor runs the Ticket.

A ticket accepted for an agent that later leaves the roster still launches, but as the built-in worker; the launch records a note on the ticket naming the missing agent, so the fallback is visible on the ticket and to the worker instead of being silent.

## Documentation

Read the numbered documents in order; each builds only on the ones before it.

- [000 Philosophy](docs/000-philosophy.md)
- [001 Domain model](docs/001-domain.md)
- [002 Authorization](docs/002-authorization.md)
- [003 Execution](docs/003-execution.md)
- [004 Prompts](docs/004-prompts.md)
- [005 Panel](docs/005-panel.md)
- [006 Deployment](docs/006-deployment.md): manual setup, configuration, upgrades and troubleshooting
- [007 Architecture](docs/007-architecture.md)
- [008 Cookbook](docs/008-cookbook.md): adding a Source

## Development

`pnpm check` runs the typecheck, the tests and the build.

## Run locally

Local runs need Node.js 22.19+ or 24+, pnpm, and a DeepSeek Harness version within `engines.dsh` in `package.json`; [SETUP.md](SETUP.md) lists the remaining prerequisites and the accounts a full installation needs. Install the dependencies and run the checks; the build writes the `lib/` that the profile loads:

```sh
pnpm install
pnpm check   # typecheck, tests and build
```

The agent runs in a dedicated DeepSeek Harness profile, `superagent`. Create it once, on a machine that has no `superagent` profile yet, install this checkout into it, and start it:

```sh
dsh superagent --from-default-profile web --dump-config > /dev/null
dsh plugin --profile superagent add "link:$PWD"
cp examples/profile.cordis.patch.yml ~/.dsh/profiles/superagent/cordis.patch.yml  # then replace the placeholders
scripts/dsh-superagent start
scripts/dsh-superagent status
```

`status` reports health and setup problems; [docs/006-deployment.md](docs/006-deployment.md) covers configuration and upgrades.

## License

[MIT](LICENSE)
