import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

const PANE = 'md-preview'
const TOOL = 'markdown_preview'
// One drawing of a Markdown element holds at most 100000 characters.
const MAX_CHARS = 100_000
const POLL_MS = 1000
// Assumed terminal width until one has been seen.
const FALLBACK_COLUMNS = 80
const USAGE =
  'Usage: /md [--width <columns>|<percent>%] [path]\n' +
  '  no path: the last file; --width alone changes the open pane.\n' +
  '  The dock is at most 45% of the terminal wide and at least 24 columns.'

const path = atom({ plugin: 'md-preview', key: 'path' } as const, '', {
  shape: 'path-1',
})
const mtimeMs = atom({ plugin: 'md-preview', key: 'mtimeMs' } as const, 0, {
  shape: 'mtime-1',
})
const width = atom({ plugin: 'md-preview', key: 'width' } as const, '', {
  shape: 'width-1',
})
const terminalColumns = atom({ plugin: 'md-preview', key: 'terminalColumns' } as const, 0, {
  shape: 'terminal-columns-1',
})

// The terminal width the pane last drew at: a render hook may not write
// state, so it is kept here (lost on reload; `/md` stores it in state).
let drawnColumns = 0

function baseName(file: string) {
  return file.slice(file.lastIndexOf('/') + 1)
}

// Checks a width spec: whole columns ('80') or a percentage ('40%').
function isWidthSpec(spec: string) {
  const match = /^(\d+)(%?)$/.exec(spec)
  if (match === null) {
    return false
  }
  const value = Number(match[1])

  return match[2] === '%' ? value >= 1 && value <= 100 : value >= 1
}

// Turns a width spec into the columns to ask the dock for; undefined for the
// engine's default. The engine clamps the result to 24..45% of the terminal.
function toColumns(spec: string, columns: number) {
  if (spec === '') {
    return undefined
  }
  if (spec.endsWith('%')) {
    return Math.max(1, Math.round((columns * Number(spec.slice(0, -1))) / 100))
  }

  return Number(spec)
}

// Splits `/md` arguments into a width spec and a path; a bad width is an error.
function parseArgs(args: string) {
  const words = args.trim().split(/\s+/).filter(word => word !== '')
  let spec: string | undefined
  const rest: string[] = []
  for (let i = 0; i < words.length; i++) {
    const word = words[i] ?? ''
    if (word === '--width' || word === '-w') {
      spec = words[++i] ?? ''
    } else if (word.startsWith('--width=')) {
      spec = word.slice('--width='.length)
    } else if (word === '--help' || word === '-h') {
      return { error: USAGE }
    } else {
      rest.push(word)
    }
  }
  if (spec !== undefined && !isWidthSpec(spec)) {
    return { error: `Bad width "${spec}": give columns (80) or a percentage (40%).\n${USAGE}` }
  }

  return { spec, file: rest.join(' ') }
}

// Opens (or reopens) the pane for the file shown, at the width in state.
async function openPane($: EngineInterface, file: string) {
  const stored = await read($, terminalColumns)
  const seen = stored > 0 ? stored : drawnColumns > 0 ? drawnColumns : FALLBACK_COLUMNS
  const columns = toColumns(await read($, width), seen)

  return $.ui.open({ id: PANE, title: baseName(file), ...(columns === undefined ? {} : { columns }) })
}

// Applies an optional width spec and shows `requested` (or the file shown
// last when empty) in the pane. Answers a message.
async function show($: EngineInterface, requested: string, spec: string | undefined) {
  if (spec !== undefined) {
    await update($, width, () => spec)
  }
  const wanted = requested.trim() || (await read($, path))
  if (wanted === '') {
    return USAGE
  }
  const stat = await $.fs.stat(wanted, { resolve: true }).catch(() => undefined)
  const real = stat?.realPath
  if (stat === undefined || real === undefined) {
    return `No such file: ${wanted}`
  }
  if (stat.kind !== 'file') {
    return `Not a file: ${wanted}`
  }
  await update($, path, () => real)
  await update($, mtimeMs, () => stat.mtimeMs)
  await openPane($, real)
  const shownWidth = (await read($, width)) || 'default'

  return `Showing ${real} in the Markdown pane (width: ${shownWidth}).`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'md',
      description: 'Render a Markdown file in a pane: /md [--width 80|40%] [path]',
    })
    await $.tool.register({
      name: TOOL,
      description:
        'Open a pane beside the chat that renders a Markdown file, and keeps it ' +
        'updated as the file changes. Use it when the user asks to render, preview ' +
        'or show a Markdown file.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Path of the Markdown file, absolute or relative to the working directory',
          },
          width: {
            type: 'string',
            description:
              'Optional pane width: whole columns ("80") or a percentage of the ' +
              'terminal ("40%"). Kept for later opens. The dock is at most 45% of ' +
              'the terminal wide.',
          },
        },
        required: ['path'],
      },
    })

    // Redraw when the shown file changes on disk.
    $.clock.every(POLL_MS, async () => {
      const file = await read($, path)
      if (file === '') {
        return
      }
      const stat = await $.fs.stat(file).catch(() => undefined)
      const seen = stat?.mtimeMs ?? -1
      if (seen !== (await read($, mtimeMs))) {
        await update($, mtimeMs, () => seen)
      }
    })

    // A reload keeps the file and width chosen before it: show them again.
    const file = await read($, path)
    if (file !== '') {
      void openPane($, file)
    }

    return next(e)
  })

  on('command.run', { command: 'md' }, async ($, e) => {
    await update($, terminalColumns, () => e.presentation.columns)
    const parsed = parseArgs(e.args)
    if ('error' in parsed) {
      return { text: parsed.error ?? USAGE }
    }

    return { text: await show($, parsed.file ?? '', parsed.spec) }
  })

  on('tool.call', { tool: 'mcp__md-preview__markdown_preview' }, async ($, e) => {
    const input = e as unknown as { path?: unknown; width?: unknown }
    const requested = typeof input.path === 'string' ? input.path : ''
    const spec = typeof input.width === 'string' ? input.width.trim() : undefined
    if (spec !== undefined && spec !== '' && !isWidthSpec(spec)) {
      return { result: `Bad width "${spec}": give columns ("80") or a percentage ("40%").` }
    }
    const text = await show($, requested, spec || undefined).catch(
      (error: unknown) => `Could not open the Markdown pane: ${String(error)}`,
    )

    return { result: text }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Markdown } = $.ui.resolve(e)
    drawnColumns = e.viewport?.columns ?? drawnColumns
    const file = await read($, path)
    // Read so that a change of the file's mtime redraws the pane.
    await read($, mtimeMs)
    if (file === '') {
      return <Text dimColor>No file chosen. Use /md &lt;path&gt;.</Text>
    }
    const text = await $.fs.read(file).catch(() => undefined)
    if (text === undefined) {
      return <Text color="red">Cannot read {file}</Text>
    }
    const isCut = text.length > MAX_CHARS

    return (
      <Box flexDirection="column">
        <Text dimColor>{file}</Text>
        <Markdown text={isCut ? text.slice(0, MAX_CHARS) : text} />
        {isCut && <Text dimColor>(cut at {MAX_CHARS} characters)</Text>}
      </Box>
    )
  })
}
