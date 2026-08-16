# Contributing

## Development

Requirements:

- Node.js 22
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

## Pull requests

Keep changes focused and describe the Markdown mode transitions you tested manually. Add or update tests when changing transition detection. CI must compile, lint, test, and package the extension successfully.
