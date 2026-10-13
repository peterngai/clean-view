export type CleanViewTaskStatus = 'done' | 'active' | 'upcoming'

export type CleanViewTask = {
  id: string
  name: string
  status: CleanViewTaskStatus
  percent: number
  hasReported: boolean
}

export type CleanViewPhase = 'working' | 'needsYou' | 'stuck' | 'stopped' | 'done'

export type CleanViewChecklist = {
  title: string
  phase: CleanViewPhase
  tasks: CleanViewTask[]
  needsYouReason: string | null
  stuckReason: string | null
  startedAt: number
  finishedAt: number | null
  isCollapsed: boolean
  /** Counts up with each new job, so a late answer for an old job is ignored. */
  jobId: number
  /** True once Claude laid out a real plan (plan_steps or a to-do list). */
  hasPlan: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'clean-view': {
      cleanViewEnabled: boolean
      checklist: CleanViewChecklist | null
      tick: number
    }
  }
}
