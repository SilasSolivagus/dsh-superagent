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

```json
{
  "version": 1,
  "enabled": false,
  "agents": [
    { "id": "default-worker", "skills": ["*"], "scopes": ["*"], "concurrency": 2, "cost": "mid" },
    { "id": "ui", "skills": ["visual", "copy"], "scopes": ["acme/widgets"], "concurrency": 1, "cost": "low" }
  ]
}
```

`version` must be `1`. `enabled` is the master switch and defaults to `false`. This prototype implements only shadow mode: whether it is `false` or `true`, each explicit accept records what routing would choose and the Ticket is accepted exactly as before. A missing or invalid record falls back to the single wildcard `default-worker` above.

Each agent names the work it can take:

- `skills`: work types (`copy`, `visual`, `bugfix`, `refactor`, `test`, `docs`, `infra`, `review`, `other`). `*` matches every type, but contributes only 0.25 to the rank, while naming the type contributes 1. Adding an agent that names a type can therefore be enough for routing to prefer it over the wildcard default.
- `scopes`: repositories as `owner/name`; `*` matches any. An agent whose scopes exclude the repository is not considered.
- `concurrency`: the most Tickets the agent may hold at once, from 1 to 16. A full agent is not considered.
- `cost`: `low`, `mid` or `high`; a lower cost ranks higher when the other factors are equal.

`preset` and `model` are optional overrides for the worker preset and the model from the execution settings. The router writes each decision to `assignees-shadow:<decisionId>`: the work type, the chosen assignee with its score and evidence, any fallback reason, and whether `enabled` was on when the decision was made.

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

## License

[MIT](LICENSE)
