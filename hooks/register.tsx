import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

const PANE = 'md-preview'
const TOOL = 'markdown_preview'
// One drawing of a Markdown element holds at most 100000 characters.
const MAX_CHARS = 100_000
const POLL_MS = 1000
// Assumed terminal size until one has been seen.
const FALLBACK_COLUMNS = 80
const FALLBACK_ROWS = 24
const USAGE =
  'Usage: /md [--width <columns>|<percent>%] [--height <rows>|<percent>%]\n' +
  '           [--watch|--no-watch] [--reload] [path]\n' +
  '  no path: the last file; options alone change the open pane.\n' +
  '  --watch (default) redraws the pane when the file changes on disk;\n' +
  '    --no-watch stops that. --reload (-r) redraws it now.\n' +
  '  --width applies while the pane is docked beside the chat (fullscreen layout):\n' +
  '    at most 45% of the terminal wide and at least 24 columns.\n' +
  '  --height applies while the pane sits above the prompt (main-screen layout).'

const path = atom({ plugin: 'md-preview', key: 'path' } as const, '', {
  shape: 'path-1',
})
const mtimeMs = atom({ plugin: 'md-preview', key: 'mtimeMs' } as const, 0, {
  shape: 'mtime-1',
})
const width = atom({ plugin: 'md-preview', key: 'width' } as const, '', {
  shape: 'width-1',
})
const height = atom({ plugin: 'md-preview', key: 'height' } as const, '', {
  shape: 'height-1',
})
const terminalColumns = atom({ plugin: 'md-preview', key: 'terminalColumns' } as const, 0, {
  shape: 'terminal-columns-1',
})
const isWatching = atom({ plugin: 'md-preview', key: 'isWatching' } as const, true, {
  shape: 'is-watching-1',
})
const revision = atom({ plugin: 'md-preview', key: 'revision' } as const, 0, {
  shape: 'revision-1',
})

// The terminal size the pane last drew at: a render hook may not write state,
// so it is kept here (lost on reload; `/md` stores the columns in state, but
// a command is told no rows).
let drawnColumns = 0
let drawnRows = 0
// The text last read for the pane, under the key it was read for: the file,
// the revision and, while watching, its mtime. With watching off, redraws
// (a scroll, a resize) reuse it, so only `--reload` shows a newer file.
let cached: { key: string; text: string | undefined } | undefined

type Sizes = { width?: string; height?: string }
// What a `/md` run or a tool call asks for besides the file.
type Options = { sizes: Sizes; isWatching?: boolean; isReload?: boolean }

function baseName(file: string) {
  return file.slice(file.lastIndexOf('/') + 1)
}

// Checks a size spec: whole cells ('80') or a percentage ('40%').
function isSizeSpec(spec: string) {
  const match = /^(\d+)(%?)$/.exec(spec)
  if (match === null) {
    return false
  }
  const value = Number(match[1])

  return match[2] === '%' ? value >= 1 && value <= 100 : value >= 1
}

// Turns a size spec into the cells to ask for, out of `total`; undefined for
// the engine's default.
function toCells(spec: string, total: number) {
  if (spec === '') {
    return undefined
  }
  if (spec.endsWith('%')) {
    return Math.max(1, Math.round((total * Number(spec.slice(0, -1))) / 100))
  }

  return Number(spec)
}

// Splits `/md` arguments into options and a path; a bad size is an error.
function parseArgs(args: string) {
  const words = args.trim().split(/\s+/).filter(word => word !== '')
  const sizes: Sizes = {}
  const options: Options = { sizes }
  const rest: string[] = []
  for (let i = 0; i < words.length; i++) {
    const word = words[i] ?? ''
    if (word === '--watch') {
      options.isWatching = true
    } else if (word === '--no-watch') {
      options.isWatching = false
    } else if (word === '--reload' || word === '-r') {
      options.isReload = true
    } else if (word === '--width' || word === '-w') {
      sizes.width = words[++i] ?? ''
    } else if (word.startsWith('--width=')) {
      sizes.width = word.slice('--width='.length)
    } else if (word === '--height' || word === '-H') {
      sizes.height = words[++i] ?? ''
    } else if (word.startsWith('--height=')) {
      sizes.height = word.slice('--height='.length)
    } else if (word === '--help' || word === '-h') {
      return { error: USAGE }
    } else {
      rest.push(word)
    }
  }
  const bad = checkSizes(sizes)
  if (bad !== undefined) {
    return { error: `${bad}\n${USAGE}` }
  }

  return { options, file: rest.join(' ') }
}

// Explains the first invalid size spec, or undefined when all are valid.
function checkSizes(sizes: Sizes) {
  for (const [name, spec] of Object.entries(sizes)) {
    if (spec !== undefined && !isSizeSpec(spec)) {
      return `Bad ${name} "${spec}": give whole cells (80) or a percentage (40%).`
    }
  }

  return undefined
}

// Opens (or reopens) the pane for the file shown, at the sizes in state. The
// engine applies `columns` while docked, `rows` while inline, and clamps both.
async function openPane($: EngineInterface, file: string) {
  const stored = await read($, terminalColumns)
  const seenColumns = stored > 0 ? stored : drawnColumns > 0 ? drawnColumns : FALLBACK_COLUMNS
  const seenRows = drawnRows > 0 ? drawnRows : FALLBACK_ROWS
  const columns = toCells(await read($, width), seenColumns)
  const rows = toCells(await read($, height), seenRows)

  return $.ui.open({
    id: PANE,
    title: baseName(file),
    ...(columns === undefined ? {} : { columns }),
    ...(rows === undefined ? {} : { rows }),
  })
}

// Applies the options and shows `requested` (or the file shown last when
// empty) in the pane. Answers a message.
async function show($: EngineInterface, requested: string, options: Options) {
  const newWidth = options.sizes.width
  const newHeight = options.sizes.height
  const newIsWatching = options.isWatching
  if (newWidth !== undefined) {
    await update($, width, () => newWidth)
  }
  if (newHeight !== undefined) {
    await update($, height, () => newHeight)
  }
  if (newIsWatching !== undefined) {
    await update($, isWatching, () => newIsWatching)
  }
  if (options.isReload === true) {
    // The pane reads the revision, so bumping it redraws the pane now.
    await update($, revision, count => count + 1)
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
  const shownHeight = (await read($, height)) || 'default'
  const shownWatch = (await read($, isWatching)) ? 'on' : 'off'

  return (
    `Showing ${real} in the Markdown pane ` +
    `(width: ${shownWidth}, height: ${shownHeight}, watch: ${shownWatch}).`
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'md',
      description:
        'Render a Markdown file in a pane: /md [--width 80|40%] [--height 30|50%] ' +
        '[--watch|--no-watch] [--reload] [path]',
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
              'Optional pane width while docked beside the chat: whole columns ("80") ' +
              'or a percentage of the terminal ("40%"). Kept for later opens. At most ' +
              '45% of the terminal.',
          },
          height: {
            type: 'string',
            description:
              'Optional pane height while shown above the prompt: whole rows ("30") ' +
              'or a percentage of the terminal ("50%"). Kept for later opens.',
          },
          watch: {
            type: 'boolean',
            description:
              'Optional: whether the pane redraws when the file changes on disk ' +
              '(default true). Kept for later opens.',
          },
          reload: {
            type: 'boolean',
            description: 'Optional: redraw the pane now, re-reading the file.',
          },
        },
        required: ['path'],
      },
    })

    // Redraw when the shown file changes on disk, unless watching is off.
    $.clock.every(POLL_MS, async () => {
      const file = await read($, path)
      if (file === '' || !(await read($, isWatching))) {
        return
      }
      const stat = await $.fs.stat(file).catch(() => undefined)
      const seen = stat?.mtimeMs ?? -1
      if (seen !== (await read($, mtimeMs))) {
        await update($, mtimeMs, () => seen)
      }
    })

    // A reload keeps the file and sizes chosen before it: show them again.
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

    return { text: await show($, parsed.file ?? '', parsed.options ?? { sizes: {} }) }
  })

  on('tool.call', { tool: 'mcp__md-preview__markdown_preview' }, async ($, e) => {
    const input = e as unknown as {
      path?: unknown
      width?: unknown
      height?: unknown
      watch?: unknown
      reload?: unknown
    }
    const requested = typeof input.path === 'string' ? input.path : ''
    const sizes: Sizes = {}
    const options: Options = { sizes }
    if (typeof input.watch === 'boolean') {
      options.isWatching = input.watch
    }
    if (input.reload === true) {
      options.isReload = true
    }
    if (typeof input.width === 'string' && input.width.trim() !== '') {
      sizes.width = input.width.trim()
    }
    if (typeof input.height === 'string' && input.height.trim() !== '') {
      sizes.height = input.height.trim()
    }
    const bad = checkSizes(sizes)
    if (bad !== undefined) {
      return { result: bad }
    }
    const text = await show($, requested, options).catch(
      (error: unknown) => `Could not open the Markdown pane: ${String(error)}`,
    )

    return { result: text }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Markdown } = $.ui.resolve(e)
    drawnColumns = e.viewport?.columns ?? drawnColumns
    drawnRows = e.viewport?.rows ?? drawnRows
    const file = await read($, path)
    // Read so that a change of the file's mtime (while watching), a change of
    // the watch setting or a `--reload` redraws the pane.
    const seenMtimeMs = await read($, mtimeMs)
    const seenRevision = await read($, revision)
    const isWatchingNow = await read($, isWatching)
    if (file === '') {
      return <Text dimColor>No file chosen. Use /md &lt;path&gt;.</Text>
    }
    const key = `${file}\n${seenRevision}\n${isWatchingNow ? seenMtimeMs : 'frozen'}`
    if (cached?.key !== key) {
      cached = { key, text: await $.fs.read(file).catch(() => undefined) }
    }
    const text = cached.text
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
