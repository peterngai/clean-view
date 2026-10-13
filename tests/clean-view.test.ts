import { describe, expect, mock, test } from 'claude-code/testing'

import { cleanName } from '../hooks/names'

const PLAN = 'mcp__clean-view__plan_steps'
const PROGRESS = 'mcp__clean-view__report_progress'
const SURFACES = ['terminal', 'desktop'] as const

const BAND = {
  plugin: 'clean-view',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: true,
    maxRows: 20,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
  viewport: { columns: 85, rows: 40 },
} as const

describe('names', () => {
  test('backtick code is stripped', async () => {
    expect(cleanName('Build the pricing section in `src/Pricing.tsx`')).toBe('Build the pricing section in')
  })

  test('a path disappears from the middle of a sentence', async () => {
    expect(cleanName('Update src/app/page.tsx with the new headline')).toBe('Update with the new headline')
    expect(cleanName('fix the bug in Pricing.tsx today')).toBe('Fix the bug in today')
  })

  test('a long name is trimmed to 40 characters or fewer', async () => {
    const long = 'Write a friendly welcome message for every new visitor who arrives on the site now'
    expect(long.length).toBeGreaterThan(79)
    const cleaned = cleanName(long)
    expect(cleaned.length).toBeLessThanOrEqual(40)
    expect(cleaned.endsWith('…')).toBe(true)
    expect(cleaned.includes('  ')).toBe(false)
  })

  test('nothing left becomes a friendly fallback', async () => {
    expect(cleanName('`npm run build`')).toBe('Working on it')
  })
})

test('a to-do list plus a 60% report draws done, current, next and up next', async ($, on) => {
  mock.clock(on, { now: 1000 })
  mock.store(on)
  on('tool.call', { tool: 'TodoWrite' }, () => ({ result: { oldTodos: [], newTodos: [] } }))

  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'Read your brand notes', status: 'completed', activeForm: 'Reading' },
      { content: 'Build the pricing section', status: 'in_progress', activeForm: 'Building' },
      { content: 'Add the contact form', status: 'pending', activeForm: 'Adding' },
      { content: 'Polish the footer', status: 'pending', activeForm: 'Polishing' },
    ],
  })
  const reported = await $.tool.call({ tool: PROGRESS, task: 'Build the pricing section', percent: 60 })
  expect(reported.text ?? JSON.stringify(reported.result)).toContain('Progress noted: 60%.')

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n')

    expect(texts).toContain('✓')
    expect(texts).toContain('Read your brand notes')
    expect(texts).toContain('Done')
    expect(texts).toContain('▶')
    expect(texts).toContain('██████░░░░')
    expect(texts).toContain('60%')
    expect(texts).toMatch(/Add the contact form\s+░{10} Next/)
    expect(texts).toMatch(/Polish the footer\s+░{10} Up next/)
    expect(await ui.find({ type: 'Button', key: 'clean-view-toggle' })).toBeDefined()
    await ui.unmount()
  }
})

test('a permission prompt shows Needs you', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  on('classic.Notification', () => ({}))
  await $.tool.call({ tool: PLAN, steps: ['Read your brand notes', 'Build the pricing section'] })
  await $.classic.Notification({ message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: 'Needs you' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /needs your OK/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '‖' })).toBeDefined()
    await ui.unmount()
  }
})

test('a turn that ends waiting on the person shows the step as Paused, not Working', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  on('turn.complete', ($, e) => ({ text: e.answer }))
  await $.tool.call({ tool: PLAN, steps: ['Agree the fix with you', 'Apply the fix'] })
  await $.turn.complete({ answer: 'Shall I go ahead?', durationMs: 1, isAborted: false, turnId: 'turn-1', reason: 'answer' })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n')
    expect(texts).toContain('Needs you')
    expect(texts).toMatch(/‖ \nAgree the fix with you\s+\n░{10}\n Paused/)
    expect(texts).not.toContain('Working')
    await ui.unmount()
  }
})

test('/simple off hides the band and leaves only the button', async ($, on) => {
  const saved: Record<string, unknown> = {}
  mock.clock(on)
  on('store.get', ($, e) => ({ value: saved[e.key] }))
  on('store.set', ($, e) => {
    saved[e.key] = e.value
    return { value: undefined }
  })
  on('ui.toast', () => ({ value: undefined }))
  await $.tool.call({ tool: PLAN, steps: ['Read your brand notes', 'Build the pricing section'] })
  await $.command.run({
    command: 'simple',
    args: 'off',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: 'Build the pricing section' })).toBeUndefined()
    expect((await ui.find({ type: 'Button', key: 'clean-view-toggle' }))?.props.label).toBe('○ Clean View: OFF')
    await ui.unmount()
  }

  expect(saved.cleanViewEnabled).toBe(false)
})

test('a step at 100 is checked off and the next one starts', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  const planned = await $.tool.call({ tool: PLAN, steps: ['Read your brand notes', 'Build the pricing section', 'Polish the footer'] })
  expect(planned.text ?? JSON.stringify(planned.result)).toContain('Planned 3 steps. The first one has started.')

  const rowsOf = async () => {
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n')
    await ui.unmount()
    return texts
  }

  const before = await rowsOf()
  expect(before).toMatch(/▶ \nRead your brand notes/)
  expect(before).toMatch(/Build the pricing section\s+░{10} Next/)

  await $.tool.call({ tool: PROGRESS, task: 'Read your brand notes', percent: 100 })

  const after = await rowsOf()
  expect(after).toMatch(/✓ \nRead your brand notes\s+\n██████████\n Done/)
  expect(after).toMatch(/▶ \nBuild the pricing section/)
  expect(after).toMatch(/Polish the footer\s+░{10} Next/)
})

test('any tool is denied before a plan exists and allowed after', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  on('tool.call', { tool: 'Read' }, () => ({ result: { type: 'text', file: { filePath: '/x', content: 'hi', numLines: 1, startLine: 1, totalLines: 1 } } }))

  const blocked = await $.tool.call({ tool: 'Read', file_path: '/tmp/x' })
  expect(blocked.isError === true || blocked.deny !== undefined).toBe(true)
  expect(String(blocked.text ?? blocked.deny)).toContain('plan_steps')

  await $.tool.call({ tool: PLAN, steps: ['Read your notes', 'Write the summary'] })

  const allowed = await $.tool.call({ tool: 'Read', file_path: '/tmp/x' })
  expect(allowed.deny).toBeUndefined()
  expect(allowed.isError ?? false).toBe(false)
})
