# Contributing

## Development

Requirements:

- [mise](https://mise.jdx.dev)
- Visual Studio Code 1.131 or later

`mise.toml` pins every tool the project uses: Node.js, and hk with the linters
it runs. Install them and the npm dependencies, then validate the extension:

```sh
mise install
npm ci --omit=optional
hk check --all
npm run check
```

`npm run check` compiles the extension, type-checks the tests, and executes the
unit test suite.

### Linting and formatting

[hk](https://hk.jdx.dev) runs these checks (configured in `hk.pkl`):

- File hygiene: trailing whitespace, final newlines, line endings, byte order
  marks, merge-conflict markers, case conflicts, broken symlinks, shebangs, and
  large files
- Secrets and spelling: gitleaks and typos
- Code: Prettier, ESLint, knip (unused files, exports, and dependencies), and
  sort-package-json
- Markdown: rumdl (configured in `.rumdl.toml`)
- GitHub Actions and Dependabot: jactionlint, zizmor, and pinact (actions are
  pinned to commit SHAs)
- Tool configuration: `mise fmt` and pkl

Check or fix every file with:

```sh
hk check --all
hk fix --all
```

Run `hk install --mise` to install the git hooks. On commit, hk checks and fixes
staged files and refuses commits to `main`. On push, it runs `npm run check` and,
when `package-lock.json` changed, scans it with osv-scanner. CI runs
`hk check --all`.

ESLint's type-aware rules load `typescript-eslint` from the project's
dependencies, so run `npm ci` before linting. Run hk directly rather than from
an npm script: `npm run` puts `node_modules/.bin` first on `PATH`, so hk would
pick up the ESLint that `typescript-eslint` installs instead of the one pinned
in `mise.toml`.

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

Keep changes focused and describe the Markdown mode transitions you tested manually. Add or update tests when changing transition detection. CI must pass `hk check --all`, compile, test, and package the extension successfully.
