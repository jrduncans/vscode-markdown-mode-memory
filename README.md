# Markdown Mode Memory

Markdown Mode Memory makes Markdown files use the editor presentation you selected most recently in that workspace:

- normal text editor
- rendered Markdown Preview
- Markdown Editor (Experimental), the hybrid editor introduced in VS Code 1.131

For example, open a Markdown file, press `⇧⌘V` to switch it to rendered preview, then open another Markdown file. It opens directly as a preview. If you use **Reopen Editor With...** to select **Markdown Editor**, later Markdown files use that hybrid editor instead.

The extension remembers the mode across VS Code restarts, separately for each workspace. Switching an existing file to another Markdown mode updates the workspace preference immediately.

## Requirements

- Visual Studio Code 1.131 or later. This is the release that introduced the experimental hybrid Markdown editor.

## Permission and commands

On the first mode change in a workspace, the extension asks for permission to manage the Markdown editor preference in the workspace settings. Choosing **Not for This Workspace** or dismissing the prompt prevents both setting changes and future prompts in that workspace.

- Run **Markdown Mode Memory: Start Managing This Workspace** to opt in later without another prompt. It leaves the setting unchanged until the next time you switch a Markdown file to another view.
- Run **Markdown Mode Memory: Stop Managing and Restore Previous Preference** to stop managing the workspace and put back the `*.md` association that existed before the extension began managing it.

## How it works

The extension updates the workspace's `workbench.editorAssociations` setting only after you deliberately change a Markdown file's editor mode. VS Code then resolves later file opens using its native editor-association behavior, so this extension never replaces an editor tab after it opens.

The workspace setting applies to everyone who uses that workspace and may produce a change in `.vscode/settings.json` or the workspace file. It can also affect Markdown diff views unless `workbench.diffEditorAssociations` specifies another editor.

The extension tracks `.md` resources, matching the `*.md` editor association it manages.
