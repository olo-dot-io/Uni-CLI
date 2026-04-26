# Version Codenames

Release labels are part of the release gate, not decoration. Every tagged
version must carry a final spaceflight label:

```text
Program · Astronaut
```

Use `Astronaut` as the slot name in process docs even when the historical
person is a cosmonaut. The label is meant to make releases easy to identify in
changelogs, tags, README footers, and GitHub Releases.

## Series

| Version range | Program |
| ------------- | ------- |
| `0.1xx`       | Sputnik |
| `0.2xx`       | Vostok  |
| `0.3xx`       | Mercury |
| `0.4xx`       | Gemini  |

## Rules

- Development notes may say `Astronaut TBD`.
- Release headings, README footers, tags, and GitHub Releases must never use
  `TBD`, `TODO`, `Unreleased`, or `Next`.
- The release label must be chosen before `npm run release`, `npm version`,
  tagging, npm publish, or GitHub Release creation.
- Use the exact middle-dot separator: `Program · Astronaut`.

## Current Development Line

| Line         | Status      | Release label            |
| ------------ | ----------- | ------------------------ |
| `Unreleased` | Development | `Vostok · Astronaut TBD` |

Replace `Astronaut TBD` with the maintainer-approved astronaut before release.
