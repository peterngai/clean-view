import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, Timer } from 'claude-code'

import type { CleanViewChecklist, CleanViewTask } from '../types'
import { cleanName, fit, formatDuration, isSameName } from './names'

type $ = EngineInterface

const PLUGIN = 'clean-view'
const PLAN_TOOL = `mcp__${PLUGIN}__plan_steps`
const PROGRESS_TOOL = `mcp__${PLUGIN}__report_progress`
const STORE_KEY = 'cleanViewEnabled'

/** Tools that may run before a plan exists. */
const ALWAYS_ALLOWED = new Set([
  PLAN_TOOL,
  PROGRESS_TOOL,
  'ToolSearch',
  'TodoWrite',
  'TaskCreate',
  'TaskUpdate',
  'AskUserQuestion',
])

const PLACEHOLDERS = ['Understand your request', 'Plan the steps']
const MAX_STEPS = 8
const METER = 10
const FRAME_MS = 250
const COLLAPSE_MS = 5000
const FAILURES_TO_STUCK = 3

const NEEDS_OK = 'Claude needs your OK to continue'
const HAS_QUESTION = 'Claude has a question for you'
const WAITING_REPLY = 'Claude is waiting for your reply'
const SAID_NO = 'you said no to a step, so Claude paused'
const KEEPS_FAILING = 'a step keeps failing, Claude is trying another way'
const REFUSED = "Claude couldn't help with that request"

const enabledAtom = atom({ plugin: 'clean-view', key: 'cleanViewEnabled' } as const, true)
const checklistAtom = atom({ plugin: 'clean-view', key: 'checklist' } as const, null)
const tickAtom = atom({ plugin: 'clean-view', key: 'tick' } as const, 0)

const SYSTEM_SECTION = `# Clean View: plain-English progress

The person using this session is not technical. Tool calls, file changes and command output are hidden from them; a checklist above their prompt shows your plan and progress instead.

- For every request, even a quick question, first call \`${PLAN_TOOL}\` with every step of the job: 2 to 8 short names, in order. If it is deferred, load it with ToolSearch first. Other tools are blocked until a plan exists.
- Then call \`${PROGRESS_TOOL}\` as real progress happens on the current step, and with percent 100 the moment a step finishes. Finish every step before you end your reply.
- Write every step name in plain English a non-technical person understands. Keep it under 40 characters and start it with a verb, like "Build the pricing section".
- Never put file paths, file names, commands, code or tool names in a step name.
- If this session has TodoWrite or TaskCreate, you may use your to-do list as the plan instead; the same naming rules apply.`

// ---------------------------------------------------------------------------
// Pure checklist logic (no `$`), so it is easy to follow and to test.

function placeholderTasks(): CleanViewTask[] {
  return PLACEHOLDERS.map((name, i) => ({
    id: `placeholder-${i}`,
    name,
    status: i === 0 ? 'active' : 'upcoming',
    percent: 0,
    hasReported: false,
  }))
}

function newChecklist(title: string, now: number, jobId: number): CleanViewChecklist {
  return {
    title,
    phase: 'working',
    tasks: placeholderTasks(),
    needsYouReason: null,
    stuckReason: null,
    startedAt: now,
    finishedAt: null,
    isCollapsed: false,
    jobId,
    hasPlan: false,
  }
}

function realTasks(tasks: CleanViewTask[]): CleanViewTask[] {
  return tasks.filter(task => !task.id.startsWith('placeholder-'))
}

/** Makes `index` the current step: everything before it done, nothing else active. */
function activate(tasks: CleanViewTask[], index: number): CleanViewTask[] {
  return tasks.map((task, i) => {
    if (i < index) {
      return { ...task, status: 'done', percent: 100 }
    }

    if (i === index) {
      return { ...task, status: 'active' }
    }

    return task.status === 'active' ? { ...task, status: 'upcoming' } : task
  })
}

function applyPlan(checklist: CleanViewChecklist, steps: string[]): CleanViewChecklist {
  const previous = realTasks(checklist.tasks)
  const names = steps.map(cleanName).slice(0, MAX_STEPS)
  const tasks: CleanViewTask[] = names.map((name, i) => {
    const old = previous.find(task => isSameName(task.name, name))

    return old?.status === 'done'
      ? { ...old, id: `step-${i}` }
      : { id: `step-${i}`, name, status: 'upcoming', percent: 0, hasReported: false }
  })
  const first = tasks.findIndex(task => task.status !== 'done')

  return {
    ...checklist,
    tasks: first === -1 ? tasks : activate(tasks, first),
    hasPlan: true,
    phase: 'working',
    needsYouReason: null,
    stuckReason: null,
  }
}

function applyProgress(checklist: CleanViewChecklist, rawName: string, rawPercent: number): CleanViewChecklist {
  const name = cleanName(rawName)
  const percent = Math.max(0, Math.min(100, Math.round(Number.isFinite(rawPercent) ? rawPercent : 0)))
  let tasks = realTasks(checklist.tasks)
  let index = tasks.findIndex(task => isSameName(task.name, name))

  if (index === -1) {
    const active = tasks.findIndex(task => task.status === 'active')
    index = active === -1 ? tasks.length : active + 1
    tasks = [
      ...tasks.slice(0, index),
      { id: `extra-${checklist.tasks.length}-${index}`, name, status: 'upcoming', percent: 0, hasReported: false },
      ...tasks.slice(index),
    ]
  }

  tasks = activate(tasks, index)
  tasks[index] = { ...tasks[index]!, percent, hasReported: true }

  if (percent >= 100) {
    tasks[index] = { ...tasks[index]!, status: 'done', percent: 100 }
    const next = tasks.findIndex((task, i) => i > index && task.status !== 'done')

    if (next !== -1) {
      tasks[next] = { ...tasks[next]!, status: 'active', percent: 0, hasReported: false }
    }
  }

  return { ...checklist, tasks, phase: 'working', needsYouReason: null, stuckReason: null }
}

type Todo = { content: string; status: 'pending' | 'in_progress' | 'completed' }

function applyTodos(checklist: CleanViewChecklist, todos: readonly Todo[]): CleanViewChecklist {
  const previous = realTasks(checklist.tasks)
  const tasks: CleanViewTask[] = todos.slice(0, 20).map((todo, i) => {
    const name = cleanName(todo.content)
    const old = previous.find(task => isSameName(task.name, name))
    const status = todo.status === 'completed' ? 'done' : todo.status === 'in_progress' ? 'active' : 'upcoming'

    return {
      id: `todo-${i}`,
      name,
      status,
      percent: status === 'done' ? 100 : status === 'active' ? (old?.percent ?? 0) : 0,
      hasReported: status === 'active' ? (old?.hasReported ?? false) : false,
    }
  })

  return { ...checklist, tasks, hasPlan: tasks.length > 0 || checklist.hasPlan }
}

function applyTaskCreate(checklist: CleanViewChecklist, id: string, subject: string): CleanViewChecklist {
  const tasks = realTasks(checklist.tasks)
  const task: CleanViewTask = {
    id: `task-${id}`,
    name: cleanName(subject),
    status: 'upcoming',
    percent: 0,
    hasReported: false,
  }

  return { ...checklist, tasks: [...tasks, task], hasPlan: true }
}

function applyTaskUpdate(
  checklist: CleanViewChecklist,
  id: string,
  status: string | undefined,
  subject: string | undefined,
): CleanViewChecklist {
  const key = `task-${id}`

  if (status === 'deleted') {
    return { ...checklist, tasks: checklist.tasks.filter(task => task.id !== key) }
  }

  const tasks = checklist.tasks.map(task => {
    if (task.id !== key) {
      return task
    }

    const named = subject === undefined ? task : { ...task, name: cleanName(subject) }

    if (status === 'completed') {
      return { ...named, status: 'done' as const, percent: 100 }
    }

    if (status === 'in_progress') {
      return { ...named, status: 'active' as const }
    }

    if (status === 'pending') {
      return { ...named, status: 'upcoming' as const, percent: 0 }
    }

    return named
  })

  return { ...checklist, tasks }
}

function isFinished(checklist: CleanViewChecklist): boolean {
  return realTasks(checklist.tasks).every(task => task.status === 'done')
}

function apiErrorSentence(error: string | undefined, details: string | undefined): string {
  const text = `${error ?? ''} ${details ?? ''}`

  if (/rate.?limit|usage limit|quota/i.test(text)) {
    return 'you hit your usage limit, try again a little later'
  }

  if (/overloaded|server_error|\b5\d\d\b/i.test(text)) {
    return "Claude's servers are busy, try again in a minute"
  }

  if (/too long|context|max_tokens|too many tokens/i.test(text)) {
    return 'the conversation got too long, type /compact and try again'
  }

  if (/auth|oauth|login|credential|api key/i.test(text)) {
    return 'you need to sign in again, type /login'
  }

  if (/network|connect|socket|econn|enotfound|fetch failed|offline|timed? ?out|dns/i.test(text)) {
    return 'the internet connection dropped'
  }

  return 'something went wrong talking to Claude, try again'
}

function isPermissionRefusal(text: string): boolean {
  return /doesn't want to proceed|does not want to proceed|user (rejected|denied|declined)|was rejected|permission (was )?denied|said no/i.test(
    text,
  )
}

// ---------------------------------------------------------------------------

// Module variables: lost on a hot reload, which is fine for each of them.
let ticker: Timer | null = null
let collapseTimer: Timer | null = null
let failureStreak = 0
let lastApiError: { error?: string; details?: string } | null = null

async function isEnabled($: $): Promise<boolean> {
  return read($, enabledAtom)
}

/** Runs the 250ms animation clock only while the job is working; a paused step stands still. */
async function syncTicker($: $): Promise<void> {
  const checklist = await read($, checklistAtom)
  const isLive = checklist !== null && checklist.phase === 'working'

  if (isLive && ticker === null) {
    ticker = $.clock.every(FRAME_MS, () => {
      void update($, tickAtom, n => (n + 1) % 1_000_000).catch(() => {})
    })
  } else if (!isLive && ticker !== null) {
    ticker.cancel()
    ticker = null
  }
}

async function edit($: $, fn: (checklist: CleanViewChecklist) => CleanViewChecklist): Promise<void> {
  if ((await read($, checklistAtom)) === null) {
    const now = await $.clock.now()
    await update($, checklistAtom, current => current ?? newChecklist('Working on your request', now, 1))
  }

  await update($, checklistAtom, current => (current === null ? current : fn(current)))
  await syncTicker($)
}

async function setEnabled($: $, value: boolean): Promise<void> {
  await update($, enabledAtom, () => value)

  try {
    await $.store.set(STORE_KEY, value)
  } catch {
    // The setting still holds for this session.
  }

  try {
    $.ui.toast(value ? 'Clean View is on: technical details are hidden' : 'Clean View is off: showing everything')
  } catch {
    // A toast is a nicety.
  }
}

async function toggleEnabled($: $): Promise<void> {
  await setEnabled($, !(await isEnabled($)))
}

async function startJob($: $, prompt: string): Promise<void> {
  const now = await $.clock.now()
  const previous = await read($, checklistAtom)
  const jobId = (previous?.jobId ?? 0) + 1
  const words = cleanName(prompt).replace(/…$/, '').split(' ').slice(0, 6).join(' ')
  const title = words === 'Working on it' ? 'Working on your request' : words

  collapseTimer?.cancel()
  collapseTimer = null
  failureStreak = 0
  lastApiError = null

  await update($, checklistAtom, () => newChecklist(title, now, jobId))
  await syncTicker($)

  $.clock.after(0, () => {
    void nameJob($, prompt, jobId).catch(() => {})
  })
}

/** Asks Haiku for a short name for the job and swaps it into the header. */
async function nameJob($: $, prompt: string, jobId: number): Promise<void> {
  const ask =
    'Name this request in 2 to 6 plain English words that start with a verb, ' +
    'like "Build my landing page". No code, file names or punctuation. ' +
    'Reply with the name only.\n\nRequest:\n' +
    prompt.slice(0, 2000)

  let answer = await $.model
    .complete({ model: 'haiku', prompt: ask, effort: 'low', maxTokens: 40, timeoutMs: 15000 })
    .catch(() => $.model.complete({ model: 'haiku', prompt: ask, maxTokens: 40, timeoutMs: 15000 }))

  if (!answer.isAnswered) {
    return
  }

  const words = answer.text.replace(/["'.]/g, '').trim().split(/\s+/).slice(0, 6).join(' ')
  const title = cleanName(words)

  if (title === 'Working on it') {
    return
  }

  await update($, checklistAtom, current => (current !== null && current.jobId === jobId ? { ...current, title } : current))
}

export function registerCleanView(on: On): void {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'plan_steps',
      description:
        'Lay out every step of the job up front, in order, before doing anything else. ' +
        'Give 2 to 8 short step names in plain English that a non-technical person understands, ' +
        'each under 40 characters and starting with a verb (like "Build the pricing section"). ' +
        'Never put file paths, file names, commands, code or tool names in a step name. The first step starts right away.',
      inputSchema: {
        type: 'object',
        properties: {
          steps: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            maxItems: MAX_STEPS,
            description: 'Every step of the job, in order: 2 to 8 short plain-English names.',
          },
        },
        required: ['steps'],
      },
      isDeferred: false,
    })

    await $.tool.register({
      name: 'report_progress',
      description:
        'Report progress on the current step of the plan. Call it as real progress happens, ' +
        'and with percent 100 the moment a step finishes; the next step then starts by itself. ' +
        'Use the exact step name from the plan.',
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'The step name, exactly as planned.' },
          percent: { type: 'number', description: 'How far along the step is, 0 to 100.' },
        },
        required: ['task', 'percent'],
      },
      isDeferred: false,
    })

    await $.command.register({
      name: 'simple',
      description: 'Turn Clean View on or off (hides technical details, shows a simple checklist)',
      argumentHint: 'on|off',
    })

    const stored = await $.store.get(STORE_KEY).catch(() => undefined)

    if (typeof stored === 'boolean') {
      await update($, enabledAtom, () => stored)
    }

    await syncTicker($)

    return next(e)
  })

  on('command.run', { command: 'simple' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const value = arg === 'on' ? true : arg === 'off' ? false : !(await isEnabled($))
    await setEnabled($, value)

    return { text: value ? 'Clean View is on.' : 'Clean View is off. Every detail is visible again.' }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)

    if (!(await isEnabled($))) {
      return composed
    }

    return {
      sections: [...composed.sections, { id: `${PLUGIN}:plain-steps`, text: SYSTEM_SECTION, scope: 'session' as const }],
    }
  })

  on('turn.start', async ($, e, next) => {
    const text = e.text.trim()
    const isCommand = text.startsWith('/') || text.includes('<command-name>')
    const checklist = await read($, checklistAtom)
    lastApiError = null

    if (text !== '' && !isCommand) {
      const isReply = checklist !== null && checklist.phase === 'needsYou' && !isFinished(checklist)

      if (isReply) {
        await edit($, current => ({ ...current, phase: 'working', needsYouReason: null }))
      } else {
        await startJob($, text)
      }
    } else if (checklist !== null && (checklist.phase === 'needsYou' || checklist.phase === 'stuck')) {
      await edit($, current => ({ ...current, phase: 'working', needsYouReason: null, stuckReason: null }))
    }

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    // Subagents run untouched: no gate, no checklist.
    if (e.agentId !== undefined) {
      return next(e)
    }

    const tool = String(e.tool)
    const input = e as unknown as Record<string, unknown>

    if (tool === PLAN_TOOL) {
      const steps = Array.isArray(input.steps) ? input.steps.map(step => String(step)) : []

      if (steps.length === 0) {
        return { deny: 'Give at least one step: 2 to 8 short plain-English names, in order.' }
      }

      await edit($, current => applyPlan(current, steps))
      const planned = Math.min(steps.length, MAX_STEPS)

      return { result: `Planned ${planned} steps. The first one has started.` }
    }

    if (tool === PROGRESS_TOOL) {
      const percent = Math.max(0, Math.min(100, Math.round(Number(input.percent) || 0)))
      await edit($, current => applyProgress(current, String(input.task ?? ''), percent))

      return { result: `Progress noted: ${percent}%.` }
    }

    const checklist = await read($, checklistAtom)

    if (!ALWAYS_ALLOWED.has(tool) && (await isEnabled($)) && !(checklist?.hasPlan ?? false)) {
      return {
        deny:
          `Clean View: call ${PLAN_TOOL} first to lay out the plan in plain English ` +
          '(load it with ToolSearch if it is deferred), then try this again.',
      }
    }

    if (tool === 'AskUserQuestion') {
      await edit($, current => ({ ...current, phase: 'needsYou', needsYouReason: HAS_QUESTION }))
    } else if (checklist?.phase === 'needsYou' && checklist.needsYouReason !== WAITING_REPLY) {
      await edit($, current => ({ ...current, phase: 'working', needsYouReason: null }))
    }

    const ran = await next(e)
    const hasFailed = ran.deny !== undefined || ran.isError === true

    if (hasFailed) {
      failureStreak += 1
      const said = String(ran.deny ?? ran.text ?? '')

      if (isPermissionRefusal(said)) {
        await edit($, current => ({ ...current, phase: 'stuck', stuckReason: SAID_NO, needsYouReason: null }))
      } else if (failureStreak >= FAILURES_TO_STUCK) {
        await edit($, current => ({ ...current, phase: 'stuck', stuckReason: KEEPS_FAILING, needsYouReason: null }))
      } else if (tool === 'AskUserQuestion') {
        await edit($, current => ({ ...current, phase: 'working', needsYouReason: null }))
      }

      return ran
    }

    failureStreak = 0

    if (tool === 'TodoWrite' && Array.isArray(input.todos)) {
      const todos = input.todos as Todo[]
      await edit($, current => applyTodos(current, todos))
    } else if (tool === 'TaskCreate') {
      const created = (ran.result as { task?: { id?: unknown; subject?: unknown } } | undefined)?.task
      const id = String(created?.id ?? Date.now())
      const subject = String(created?.subject ?? input.subject ?? '')
      await edit($, current => applyTaskCreate(current, id, subject))
    } else if (tool === 'TaskUpdate') {
      const status = typeof input.status === 'string' ? input.status : undefined
      const subject = typeof input.subject === 'string' ? input.subject : undefined
      await edit($, current => applyTaskUpdate(current, String(input.taskId ?? ''), status, subject))
    }

    await edit($, current =>
      current.phase === 'stuck' || (current.phase === 'needsYou' && current.needsYouReason !== WAITING_REPLY)
        ? { ...current, phase: 'working', stuckReason: null, needsYouReason: null }
        : current,
    )

    return ran
  })

  on('classic.Notification', async ($, e, next) => {
    const kind = `${e.notification_type} ${e.message}`
    const checklist = await read($, checklistAtom)
    const isLive = checklist !== null && checklist.phase !== 'done' && checklist.phase !== 'stopped'

    if (/permission/i.test(kind) && (isLive || checklist === null)) {
      await edit($, current => ({ ...current, phase: 'needsYou', needsYouReason: NEEDS_OK }))
    } else if (/elicitation|question/i.test(kind) && isLive) {
      await edit($, current => ({ ...current, phase: 'needsYou', needsYouReason: HAS_QUESTION }))
    }

    return next(e)
  })

  on('classic.StopFailure', async ($, e, next) => {
    lastApiError = { error: e.error, details: e.error_details }
    const checklist = await read($, checklistAtom)

    if (checklist !== null) {
      const reason = apiErrorSentence(e.error, e.error_details)
      await edit($, current => ({ ...current, phase: 'stuck', stuckReason: reason, needsYouReason: null }))
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      return next(e)
    }

    const checklist = await read($, checklistAtom)

    if (checklist !== null) {
      const now = await $.clock.now()

      if (e.reason === 'error') {
        const reason = apiErrorSentence(lastApiError?.error, lastApiError?.details)
        await edit($, current => ({ ...current, phase: 'stuck', stuckReason: reason, needsYouReason: null }))
      } else if (e.reason === 'refusal') {
        await edit($, current => ({ ...current, phase: 'stuck', stuckReason: REFUSED, needsYouReason: null }))
      } else if (e.reason === 'aborted') {
        await edit($, current => ({ ...current, phase: 'stopped', needsYouReason: null, finishedAt: now }))
      } else if (checklist.phase === 'stuck' && checklist.stuckReason === SAID_NO) {
        // Leave it: Claude paused because the person said no.
      } else if (checklist.hasPlan && !isFinished(checklist)) {
        await edit($, current => ({ ...current, phase: 'needsYou', needsYouReason: WAITING_REPLY, stuckReason: null }))
      } else {
        const jobId = checklist.jobId
        await edit($, current => ({
          ...current,
          phase: 'done',
          tasks: realTasks(current.tasks).map(task => ({ ...task, status: 'done' as const, percent: 100 })),
          needsYouReason: null,
          stuckReason: null,
          finishedAt: now,
          isCollapsed: false,
        }))
        collapseTimer?.cancel()
        collapseTimer = $.clock.after(COLLAPSE_MS, () => {
          void update($, checklistAtom, current =>
            current !== null && current.jobId === jobId && current.phase === 'done'
              ? { ...current, isCollapsed: true }
              : current,
          ).catch(() => {})
        })
      }
    }

    return next(e)
  })

  // -------------------------------------------------------------------------
  // Hiding the technical rows.

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (!(await isEnabled($))) {
      return next(e)
    }

    const { Box } = $.ui.resolve(e)

    return <Box display="none" />
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (!(await isEnabled($))) {
      return next(e)
    }

    const { Box } = $.ui.resolve(e)

    return <Box display="none" />
  })

  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (!(await isEnabled($))) {
      return next(e)
    }

    const { Box } = $.ui.resolve(e)

    return <Box display="none" />
  })

  on('ui.render', { component: 'ToolProgress' }, async ($, e, next) => {
    if (!(await isEnabled($))) {
      return next(e)
    }

    return next({ ...e, props: { ...e.props, hint: '' } })
  })

  // -------------------------------------------------------------------------
  // The band above the prompt.

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }

    const { Box, Text, Button } = $.ui.resolve(e)
    const enabled = await isEnabled($)
    const checklist = enabled ? await read($, checklistAtom) : null
    const tick = checklist !== null && checklist.phase === 'working' ? await read($, tickAtom) : 0
    const width = Math.max(24, e.props.bodyColumns)

    const label = enabled ? '● Clean View: ON' : '○ Clean View: OFF'
    const button = (
      <Button key="clean-view-toggle" label={label} variant={enabled ? 'primary' : 'secondary'} onPress={() => toggleEnabled($)} />
    )
    const buttonWidth = label.length + 4

    if (checklist === null) {
      return (
        <Box flexDirection="row" justifyContent="flex-end" width={width}>
          {button}
        </Box>
      )
    }

    const now = await $.clock.now()
    const elapsed = formatDuration((checklist.finishedAt ?? now) - checklist.startedAt)
    const headWidth = Math.max(8, width - buttonWidth - 1)
    const head = (text: string) => fit(text, headWidth).trimEnd()
    let header

    if (checklist.phase === 'needsYou') {
      header = (
        <Text>
          <Text inverse bold color="warning">
            {' Needs you '}
          </Text>
          {' ' + fit(checklist.needsYouReason ?? WAITING_REPLY, Math.max(4, headWidth - 12)).trimEnd()}
        </Text>
      )
    } else if (checklist.phase === 'stuck') {
      header = <Text color="warning">{head(`⚠ Stuck: ${checklist.stuckReason ?? KEEPS_FAILING}`)}</Text>
    } else if (checklist.phase === 'stopped') {
      header = <Text>{head(`■ Stopped · ${checklist.title} · you pressed Esc`)}</Text>
    } else if (checklist.phase === 'done') {
      header = <Text color="success">{head(`✓ All done · ${checklist.title} · took ${elapsed}`)}</Text>
    } else {
      header = <Text bold>{head(`${checklist.title} · ${elapsed}`)}</Text>
    }

    const headerRow = (
      <Box flexDirection="row" justifyContent="space-between" width={width}>
        {header}
        {button}
      </Box>
    )

    if (checklist.phase === 'done' && checklist.isCollapsed) {
      return headerRow
    }

    const nameWidth = Math.max(6, width - 2 - 1 - METER - 1 - 7)
    let seenUpcoming = false
    const rows = checklist.tasks.map(task => {
      const name = fit(task.name, nameWidth)

      if (task.status === 'done') {
        return (
          <Box flexDirection="row">
            <Text color="success">{'✓ '}</Text>
            <Text dimColor>{name + ' '}</Text>
            <Text color="success">{'█'.repeat(METER)}</Text>
            <Text dimColor>{' Done'}</Text>
          </Box>
        )
      }

      if (task.status === 'active') {
        // Waiting on the person, stuck or stopped: the active step is paused, not working.
        const isPaused = checklist.phase !== 'working'
        let meter: string
        let status: string

        if (task.hasReported) {
          const filled = Math.round(task.percent / 10)
          meter = '█'.repeat(filled) + '░'.repeat(METER - filled)
          status = `${task.percent}%`
        } else if (isPaused) {
          meter = '░'.repeat(METER)
          status = 'Paused'
        } else {
          const at = tick % (METER + 3)
          meter = Array.from({ length: METER }, (_, i) => (i <= at && i > at - 3 ? '█' : '░')).join('')
          status = 'Working'
        }

        return (
          <Box flexDirection="row">
            <Text color="claude">{isPaused ? '‖ ' : '▶ '}</Text>
            <Text bold>{name + ' '}</Text>
            <Text color="claude">{meter}</Text>
            <Text>{' ' + status}</Text>
          </Box>
        )
      }

      const status = seenUpcoming ? 'Up next' : 'Next'
      seenUpcoming = true

      return (
        <Box flexDirection="row">
          <Text dimColor>{'○ ' + name + ' ' + '░'.repeat(METER) + ' ' + status}</Text>
        </Box>
      )
    })

    return (
      <Box flexDirection="column" width={width}>
        {headerRow}
        {rows}
      </Box>
    )
  })
}
