# Contributing

Thanks for helping improve NEU OneSearch MCP. This guide covers local setup, the development workflow, and how releases are cut.

## Setup

You need Node.js 20 or later (CI uses Node 22) and, for the sign-in flow, Google Chrome.

```bash
git clone https://github.com/sohampatwardhan/NEU-OneSearch-MCP.git
cd NEU-OneSearch-MCP
npm ci
npm run build
```

| Command | What it does |
| --- | --- |
| `npm run dev` | Run the MCP server from source with `tsx` |
| `npm run typecheck` | Type-check without emitting |
| `npm run build` | Clean and compile to `dist/` |
| `npm test` | Run the Vitest suite |
| `npm run install-mcp` | Register the local build with your MCP client |
| `node dist/login.js` | Sign in through Northeastern SSO (`neu-onesearch-login`) |
| `node dist/logout.js` | Delete the cached session and browser profile (`neu-onesearch-logout`) |

CI runs `npm ci`, `npm run typecheck`, `npm run build`, `npm test`, and `npm pack --dry-run` on every push and pull request. Run the same commands locally before you push.

## Credentials and session data

- Never commit or paste passwords, cookie values, `session.json`, or anything from `~/.cache/neu-onesearch-mcp/`. Cookie names are fine to share when debugging; values are not.
- Tests must not need a Northeastern account. Mock the browser, the IdP, and HTTP responses. Anything that only a live sign-in can prove goes in the pull request's testing notes as a manual check.

## Workflow

Changes follow a spec-driven flow using Kiro specs under `.kiro/specs/`.

1. **Issue.** Start from a GitHub issue that describes the idea. Open questions go as comments on the issue.
2. **Spec.** Write `requirements.md`, `design.md`, and `tasks.md` in `.kiro/specs/<slug>/`. Spec and steering documents are not code, so commit them straight to `main` (for example `docs(spec): add design for <slug>`, with `Refs #N` in the body). No pull request is needed for specs.
3. **Implementation.** Branch from `main` as `feat/<issue>-<slug>`. Make one conventional commit per task, write tests first, and tick the task in `tasks.md` in the same commit.
4. **Pull request.** Open one PR per spec against `main` with `Closes #N` on the first line, a short summary, the changes per task, and how it was tested. A human reviews and merges.

Small fixes and docs changes don't need a spec; a focused PR is fine.

### Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): summary`, imperative and lowercase, 72 characters or fewer. Common types are `feat`, `fix`, `test`, `refactor`, `docs`, `ci`, `build`, and `chore`. Reference the issue with `Refs #N` in the body; only the pull request uses `Closes`.

## Releases

The package is published to npm as `@sohampatwardhan/neu-onesearch-mcp` through npm trusted publishing.

1. Bump `version` in `package.json` and add an entry to `CHANGELOG.md` in a `chore(release): X.Y.Z` commit.
2. Push a tag `vX.Y.Z` that matches `package.json`. The Release workflow checks the match, then builds, tests, and publishes.

Feature pull requests should not bump the version or publish.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
