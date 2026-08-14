---
---

No release. The only workspace file touched is
`aws/lambda/nodejs/tests/helpers/prepare-fixture.ts`, an E2E test helper.
`@telorun/lambda` publishes `files: [dist, managed.mjs, custom.mjs, README.md,
LICENSE]`, so the shipped artifact is unchanged and no consumer-visible
behaviour moved.
