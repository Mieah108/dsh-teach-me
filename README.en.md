<p align="center"><img src="assets/brand/icon-plate.svg" width="88" height="88" alt="Teaching mode icon showing a teacher pointing at a blackboard"></p>

# dsh-teach-me · Teaching mode

[简体中文](README.md) · English

A learning preset for DeepSeek Harness with teaching skills, interactive lessons, exercises, and learning records. Start with a learning goal, generate HTML lessons you can read offline, submit exercises in the classroom, and pick up where you left off in a later session.

You can also connect your own Remotion project to create teaching animations.

> [!CAUTION]
> The plugin and preset are in beta. The interface, workflows, and generated content may be unstable. Verify AI-generated material before relying on it.

## Features

- **Guided learning.** Assess your starting point, plan short lessons around your goals, and work through explanations, practice, and feedback.
- **Interactive lessons.** Open lessons from the sidebar and explore formulas, flashcards, timelines, charts, and local media.
- **Exercises and assessment.** Submit answers, get deterministic grading for objective questions and a preliminary model assessment for open-ended questions, and keep records for review.
- **Teaching collections.** Organize multiple rounds of study in one workspace. Copy lesson lists, archive and restore collections, and keep submissions and assessments separate. Each collection pins its content versions.
- **Reading progress.** See how far you have read, resume at your last position, and view progress for lessons and collections. Mastery is tracked separately.
- **Teaching settings.** Use the button beside the preset selector to change fact-checking intensity and explanation depth for the current session. Changes apply to the next request. Set defaults for new sessions on the settings page.
- **Adjustable fact-checking.** Use 0, 1, 1–2, or 3–4 independent reviewers, depending on the selected level. By default, checks run only when generating lessons, with up to one automatic follow-up round when needed. Expand the results to inspect the evidence.
- **Learning records.** Keep lessons, questions, submissions, and assessments in your learning workspace so you can continue across sessions.
- **Offline use.** Export a standalone HTML lesson and export or import answers. Formula and component assets ship with the plugin.
- **Teaching animations.** Connect a Remotion project to sync animation source and render stills or video.

See [package.json](package.json) for the source version. The npm commands below install published versions.

## Requirements

- DeepSeek Harness `>=0.2.1-rc.3`.
- npm installation uses the host's `dsh plugin` command and requires pnpm on your `PATH`.
- Animation is **off by default** and requires a separate Remotion project with its dependencies installed.
- Development from source requires Node.js and the pnpm version specified in [package.json](package.json).

## Installation

### From npm

Use the `next` dist-tag to install the latest published beta.

```bash
dsh plugin --profile web add dsh-teach-me@next
```

To pin a version, use a specifier such as `dsh-teach-me@0.9.1-beta.1`. After installing, restart DeepSeek Harness, refresh the web client, and select **Teaching mode** in a new session.

### From a local directory

Download a source archive from [GitHub Releases](https://github.com/Mieah108/dsh-teach-me/releases) or clone the repository, then install dependencies in the project directory.

```bash
git clone https://github.com/Mieah108/dsh-teach-me.git
cd dsh-teach-me
pnpm install --frozen-lockfile
```

### Upgrading

Back up your learning workspace and Teaching mode settings before upgrading. The first explicit write moves existing lessons and records into the default collection and backs up the archive before migration. To downgrade after migration, restore that full backup. Collections and reading records move with the teaching root, while session preferences live in the host's data store. Reading progress is reported from the DSH classroom. Install the desired npm version and restart the host.

Since `0.9.0-beta.1`, Teaching mode has used the same native tool calls as the host's standard mode. Let active calls finish before upgrading and try resuming the original session after restarting. Answer pending questions in their original cards or ask the tutor to pose them again if the cards cannot be restored. If the session cannot be resumed, start a new Teaching mode session in the same workspace to keep using your lessons and records.

Starting with `0.9.1-beta.1`, the web client shows a one-time welcome page that explains where to select the preset, adjust session and default settings, and enable Remotion. Closing it saves `welcome.seen` in the host settings across refreshes, browsers, and host restarts. To reopen it, go to **Settings → Teaching mode → Show the welcome page**.

## Quick start

1. Open a learning workspace and select **Teaching mode** in a new session.
2. Tell the tutor your goal, what you already know, and which materials to use. For example, “I know calculus and want to understand the Fourier transform. Start with an intuitive example.”
3. Answer the diagnostic questions and confirm the lesson plan. The tutor will generate lessons and exercises.
4. Open a lesson from **Teaching mode · Lessons** in the sidebar. Read, explore the interactive components, and answer the questions.
5. Choose **Submit to classroom** to save your answers, then use the feedback to guide further study or review.

Lesson self-checks and classroom submissions are separate. Your learning records are stored in the selected workspace for later sessions.

## Configuration

Configure animation in **Settings → Teaching mode** in DSH.

| Setting | Description | Default |
| --- | --- | --- |
| `animation.root` | Absolute path to the Remotion project. Leave blank to disable animation. | Empty |
| `animation.softLimitSeconds` | Suggested animation length, from 10 to 600 seconds | `120` |
| `animation.missing` | Skip animation (`skip`) or show a warning (`warn`) when the project is missing | `skip` |
| `animation.staging` | Store animation source in a staging directory in the workspace | On |

See [architecture and configuration](docs/architecture.md) for more options and the [animation guide](templates/ANIMATION.md) for Remotion setup.

## Documentation

| Document | Contents |
| --- | --- |
| [Documentation index](docs/README.md) | Architecture, testing, and maintenance |
| [Lesson formats](templates/FORMATS.md) | HTML lessons, LessonSpec, and learning records |
| [Interactive components](templates/COMPONENTS.md) | Flashcards, timelines, charts, and examples |
| [Animation guide](templates/ANIMATION.md) | Remotion setup and animation production |
| [Glossary](GLOSSARY.md) | Project concepts and tool terminology |
| [Changelog](CHANGELOG.md) | Changes by version |
| [Versioning and releases](docs/versioning.md) | GitHub Releases, npm publishing, and local dry runs |

After downloading or cloning the source, open the [component examples](templates/examples/lessons/components.html) and the [component reuse example](templates/examples/lessons/reuse.html) in a browser.

### Command-line tools

Use these tools to compile, validate, and patch lessons or maintain a learning workspace.

```bash
node scripts/lesson-compile.mjs --check lesson.spec.json
node scripts/lesson-compile.mjs lesson.spec.json lesson.html
node scripts/lesson-lint.mjs --help
node scripts/lesson-patch.mjs --help
node scripts/teach-workspace.mjs --help
```

## Development

Install dependencies and run the source checks from the repository root.

```bash
pnpm install --frozen-lockfile
pnpm verify:source
```

| Command | Purpose |
| --- | --- |
| `pnpm test` | Run unit tests |
| `pnpm selftest` | Run the plugin self-test |
| `pnpm build:components` | Build lesson components |
| `pnpm check:components` | Verify component sources and build output |

See the [testing guide](docs/testing.md) for details.

## Usage notes and limitations

- The classroom sidebar and automatic lesson opening depend on the DSH deployment and client support.
- For important open-ended assessments, review the original submission and supporting evidence.
- Animation rendering depends on the local Remotion, browser, and font setup. See [animation and permissions](docs/architecture.md#动画与权限) for platform and permission limits.
- Back up the lessons and learning records stored in your workspace regularly.

## Roadmap

- [ ] Improve teaching animation reliability
- [ ] Offer more HTML lesson templates
- [ ] Add RAG knowledge base support
- [ ] Improve the plugin UI, including settings and lesson selection
- [ ] Stabilize multilingual support

## Contributing

Report bugs or suggest improvements through [GitHub Issues](https://github.com/Mieah108/dsh-teach-me/issues). Pull requests are welcome.

For bug reports, include the project version, DeepSeek Harness version, operating system, steps to reproduce, and expected behavior. Run `pnpm verify:source` before submitting code. When adding or updating third-party resources, record their sources and licenses.

## License and credits

Original project content is licensed under the [BSD 3-Clause License](LICENSE). Third-party code, skills, and assets retain their own licenses. See [ATTRIBUTIONS.md](ATTRIBUTIONS.md) for distribution scope, pinned versions, and license details.

- **Host and teaching skills.** [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) and [Matt Pocock's teach skill](https://github.com/mattpocock/skills).
- **Lesson components and recipes.** [DeepTutor](https://github.com/HKUDS/DeepTutor) and [OpenMAIC](https://github.com/THU-MAIC/OpenMAIC).
- **Frontend and math.** [React, ReactDOM, and scheduler](https://github.com/facebook/react), [Apache ECharts](https://github.com/apache/echarts), [zrender](https://github.com/ecomfe/zrender), [D3.js](https://github.com/d3/d3), [tslib](https://github.com/microsoft/tslib), and [MathJax](https://github.com/mathjax/MathJax).
- **Animation, runtime, and development dependencies.** [Remotion](https://github.com/remotion-dev/remotion), [DeepSeek Schemastery](https://github.com/deepseek-ai/deepseek-harness/tree/main/vendor/schemastery), [Zod](https://github.com/colinhacks/zod), [esbuild](https://github.com/evanw/esbuild), and [linkedom](https://github.com/WebReflection/linkedom).
