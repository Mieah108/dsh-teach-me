# dsh-teach-me

A DeepSeek Harness (DSH) preset and plugin for interactive HTML lessons, classroom submissions, and learning records.

## Background and Compatibility

- Start with `cordis.patch.yml` and `lib/index.js`. The `host` entry provides settings and classroom services. The `runtime` entry registers teaching tools, skills, and prompts in teaching sessions.
- Check `engines.dsh` in `package.json` for the supported range. Before changing host hooks, slots, or tool calls, verify the contract against the relevant DSH source or installed package. Read the [architecture notes](docs/architecture.md) and [ADRs](docs/adr/README.md) for changes to host integration, storage, or permissions.

## Coding Standards

- Make the smallest complete change. Reuse existing code, tests, and public DSH APIs. Preserve read-only behavior and treat the append-only journal as the source of truth for learning records.
- For teaching flow, start in `prompt/`. For lesson, question, or record formats, consult the [format reference](templates/FORMATS.md) and use terms from the [glossary](GLOSSARY.md).
- Keep vendored originals in `skills/teach/` and `ui/upstream/` pinned. When updating them, verify provenance, hashes, and licenses, and update [ATTRIBUTIONS.md](ATTRIBUTIONS.md).

## UI and Localization

- Follow [DESIGN.md](DESIGN.md) and reuse public DSH controls and tokens in `client.js`. Keep Chinese and English UI copy in sync. Check layout changes at narrow and wide pane widths in light and dark themes.
- Edit course component sources in `ui/`, then regenerate `templates/components/` with `pnpm build:components`.

## Build and Checks

- Use the Node version in [CI](.github/workflows/ci.yml) and the pnpm version in `package.json`. Install with `pnpm install --frozen-lockfile`.
- Start with the relevant `node --test` files and run `pnpm verify:source` before committing code changes. Use synthetic data and temporary workspaces. Report local checks and real DSH results separately as described in [testing](docs/testing.md).

## Git and Releases

- Write commit messages in English and group changes by purpose. Before committing or pushing, review the full diff and remove or redact machine-specific absolute paths, personal information, and other non-public material. The configured Git author identity is exempt.
- Bump the version only for a release and update `CHANGELOG.md` with it. A version bump pushed to `main` can trigger npm publication. Follow the [release guide](docs/versioning.md).
