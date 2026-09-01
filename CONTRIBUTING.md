# Contributing

Use Node.js 20 or newer. Fork the repository, create a focused branch, and run:

```bash
npm ci
npm test
npm pack --dry-run
```

Keep provider translations isolated in `src/providers`, expose new behavior through the normalized interfaces, and add deterministic tests. New mutating tools must declare `mutating: true`. Security-sensitive changes should explain their threat model in the pull request.

Commits should be small, imperative, and signed with your own Git identity. By contributing, you agree that your changes are licensed under MIT.
