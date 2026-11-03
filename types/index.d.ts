declare module 'claude-code' {
  interface PluginState {
    'md-preview': {
      // Absolute path of the file shown; '' when none was chosen yet.
      path: Shaped<string>
      // The file's mtime when last seen; a change redraws the pane.
      mtimeMs: Shaped<number>
      // The requested pane width: columns ('80') or a share of the terminal
      // ('40%'); '' for the engine's default.
      width: Shaped<string>
      // The terminal's width in columns when last seen; 0 when not seen yet.
      terminalColumns: Shaped<number>
    }
  }
}
