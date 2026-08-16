# Contributing

## Development

Requirements:

- Node.js 24
- Visual Studio Code 1.131 or later

Install dependencies and validate the extension:

```sh
npm ci --omit=optional
npm run check
```

`npm run check` type-checks the extension and tests, runs ESLint, and executes the unit test suite.

Press `F5` in Visual Studio Code to launch an Extension Development Host for manual testing.

Build an installable package with:

```sh
npm run package:vsix
```

## Releases

Releases are created from GitHub Releases. Before publishing a release, update
`package.json`, `package-lock.json`, and `CHANGELOG.md`, then merge the version
change to `main` and create a GitHub Release tagged `v<package-version>` from
that commit. For example, package version `0.2.0` requires the tag `v0.2.0`.

Publishing the GitHub Release runs the release workflow. It validates the
extension, builds `markdown-mode-memory.vsix`, attaches it to the GitHub
Release, and does not require publishing credentials.

To retry packaging for an existing release, run the Release workflow manually
with the release tag and its prerelease status.

After the workflow completes, download `markdown-mode-memory.vsix` from the
GitHub Release and upload it through the [Visual Studio Marketplace publisher
management page](https://marketplace.visualstudio.com/manage/publishers/). If
the GitHub Release is a prerelease, the workflow marks the VSIX for the
Marketplace prerelease channel during packaging.

## Pull requests

Keep changes focused and describe the Markdown mode transitions you tested manually. Add or update tests when changing transition detection. CI must compile, lint, test, and package the extension successfully.
