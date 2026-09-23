# Contributing

Thanks for helping improve AI Skills Manager. Contributions are especially welcome from people who use tools that are difficult to test locally, including Hermes, Pi, Goose, Trae, and other tools in the supported-tools list.

## Development setup

```bash
npm install
npm test
npm run build
npm run lint
```

Use `npm run dev` while developing the Obsidian plugin. The production build writes the bundled plugin code to `main.js`.

## What to contribute

Useful contributions include:

- Adding or correcting a tool's default paths
- Improving support for skills, agents, commands, rules, or plugin bundles
- Adding scanner tests and filesystem fixtures
- Reporting differences between a tool's documented layout and its current behavior

## Adding or updating a tool

Tool definitions live in `src/types.ts`, mainly in `DEFAULT_TOOLS`. A tool definition can describe:

- Global paths for skills, agents, commands, and rules
- Project-scoped paths
- Plugin registries or installed plugin cache paths
- Plugin-specific paths when a bundle uses a different directory layout
- Single-file rules, disabled-folder conventions, and built-in directories

When changing a tool definition:

1. Confirm the layout from the tool's official documentation or a reproducible local install.
2. Keep paths conservative. An unconfirmed path can be added as an optional or clearly marked guess rather than silently scanning unrelated folders.
3. Add or update a test in the relevant `src/*.test.ts` file.
4. Explain the tested layout in the pull request.

You do not need to install the tool to contribute a scanner change. A small temporary directory fixture is usually enough.

## Scanner fixtures and tests

Scanner tests should create their own temporary directories and clean up through the existing test setup. Include representative files such as:

- A valid manifest or markdown item
- Frontmatter when the tool supports it
- Nested skill files or companion directories when relevant
- Disabled items, symlinks, or versioned plugin folders when relevant
- Invalid or unrelated files that should be ignored

Tests should verify both what is discovered and what is intentionally ignored. Do not use real home-directory paths, personal vault paths, private repositories, or committed copies of tool configuration files.

## Reporting support issues

When reporting a tool-specific issue, include:

- The tool name and version
- The operating system
- The directory layout, with private names and paths redacted
- The expected result and what AI Skills Manager actually found
- A minimal fixture or reproduction, if possible

Never include API keys, tokens, private prompts, session transcripts, or other sensitive configuration data.

## Pull requests

Keep pull requests focused and describe:

- What changed
- Which tool or behavior it affects
- How it was tested
- Whether the change was tested against a real installation or a fixture

Before opening a pull request, run:

```bash
npm test
npm run build
npm run lint
```

If a command cannot run in your environment, mention that in the pull request rather than skipping the explanation.

## Generated files and screenshots

The production build updates `main.js`, so include that generated file when the source changes require it. Keep screenshots focused on the feature they document and remove personal paths, workspace names, and private content before committing them.

