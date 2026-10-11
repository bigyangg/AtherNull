# AtherNull demo API

A tiny, dependency-free notes API (`node:http`, tests with `node --test`)
used to demo AtherNull builds: it builds and tests in an offline sandbox.

```sh
npm test      # node --test
npm start     # http://localhost:3000
```

Endpoints: `GET /health`, `GET /notes`, `POST /notes {"text"}`,
`GET /notes/:id`.

Good first builds to ask the agent for:
- "Add GET /version that returns the version from package.json as JSON, with a test."
- "Add DELETE /notes/:id (204, or 404 for unknown notes), with tests."
- "Reject notes longer than 280 characters with a 400, with a test."

`node scripts/dev.mjs` copies this folder into a standalone git repository
(`~/.athernull/demo-api`) that a project can point at. To demo from GitHub
instead, push that repository and import its URL.
