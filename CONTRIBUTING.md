# Contributing to ClawFeed

## Getting Started

```bash
git clone https://github.com/kevinho/clawfeed.git
cd clawfeed
npm install
cp .env.example .env  # fill in your API keys
npm run dev
```

## Branch Rules

- `main` is protected — no direct pushes
- All changes go through pull requests
- PRs require: CI passing + 1 approving review

## Workflow

1. Create a feature branch from `develop`:
   ```bash
   git checkout -b feat/your-feature develop
   ```
2. Make your changes
3. Run checks locally:
   ```bash
   npm run lint
   npm test
   ```
4. Push and open a PR to `develop` — the template will guide you
5. Address review feedback, then wait for merge

For the full development and release process, see [PROCESS.md](PROCESS.md).

## Code Style

- ESM modules (`.mjs` extensions, `"type": "module"`)
- ESLint enforced — run `npm run lint` before pushing
- Keep functions small and focused

## Review Process

Every PR goes through:
1. **CI** — lint + e2e tests + npm audit (automated)
2. **Codex CLI review** — iterative until CLEAN
3. **Reviewer approval** — code quality + functionality
4. **Owner merge** — Kevin merges in order, resolving any rebase conflicts

## Reporting Issues

Open a GitHub issue with:
- Steps to reproduce
- Expected vs actual behavior
- Environment details (Node version, OS)
