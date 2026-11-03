# Markdown preview for Claude Code

A Claude Code mod that renders a Markdown file in a pane beside the chat and
redraws it whenever the file changes. Keep a README, design document or notes
file in view while Claude edits it.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install md-preview --marketplace juchem/claude-code-md-preview
```

Answer `y` to add the marketplace, then pick a scope. The mod is active right
away.

From a shell:

```
claude plugin install md-preview --marketplace juchem/claude-code-md-preview
```

In the desktop app, where `/plugin` does not run: click **+** next to the
prompt box, then **Plugins**, **Add marketplace** with
`juchem/claude-code-md-preview`, then **Add plugin**.

## Usage

- **`/md <path>`:** opens the pane for a Markdown file.
- **`/md`:** reopens the last file.
- **`/md --width <columns>|<percent>%`:** sets the pane's width, for example
  `/md --width 40% README.md`. The width is kept for later opens.
- **`/md --help`:** shows the options.
- **Asking Claude:** Claude can also open the pane, for example "render
  README.md in a pane". The mod gives Claude a `markdown_preview` tool for
  this, taking the same width option.
- **Scrolling:** use the mouse wheel or the scroll keys over the pane.

## Design

- **Rendering:** the pane draws the file with Claude Code's own Markdown
  renderer, the one that draws Claude's replies. Headings, tables, lists,
  code blocks and links look the same as in the conversation, and no external
  tool is involved.

  Terminal renderers such as `glow` don't work for this. Claude Code shows a
  command's output as plain text and doesn't interpret its color codes, so
  only content drawn by Claude Code itself can be styled inside a session.

- **Live updates:** the mod checks the file's modification time once a second
  and redraws the pane when it changes, so edits by Claude, an editor or any
  other process show up on their own.

- **State:** the file shown and the chosen width are kept in the session's
  plugin state. A reload of the mod, or a bare `/md`, brings back the same
  view.

- **Width:** a width is a request to Claude Code, not a guarantee.
  - **Clamping:** Claude Code clamps the pane to between 24 columns and 45%
    of the terminal.
  - **Layout:** the width only applies when the pane is docked beside the
    transcript, which happens in the fullscreen layout from 110 terminal
    columns. On the main screen, the default under tmux and byobu, the pane
    sits above the prompt and the width is ignored.
  - **Percentages:** a percentage is converted to columns when the pane
    opens, using the terminal width Claude Code last reported. It doesn't
    follow later resizes; run `/md` again after resizing.
  - **Precedence:** a width set by dragging the pane's edge with the mouse
    wins over the requested one. That only works where mouse support is on.

- **Placement:** a pane opened with `/md` appears at any terminal width. One
  that Claude opens on its own appears only from 144 terminal columns (110
  once you've opened the pane yourself in an earlier session) and waits
  undrawn below that.

## Limits

- One pane, showing one file at a time.
- Files over 4 MiB can't be read. Only the first 100,000 characters are drawn,
  and the pane says when it cut the file.
- Links use `https:`, `http:` and `file:` only; others show as plain text.

## Development

The mod is a single hooks module, `hooks/register.tsx`, with its state
contract in `types/index.d.ts`.

To run it from a checkout:

```
claude --plugin-dir /path/to/claude-code-md-preview
```

To check it:

```
claude plugin validate /path/to/claude-code-md-preview
```

Claude Code writes the API's type declarations to `.claude-plugin/types/`
when it loads the mod. After that, `tsc -p .` type-checks the module against
them.
