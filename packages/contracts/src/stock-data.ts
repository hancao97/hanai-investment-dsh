export interface StockDataStatus {
  task?: { origin: 'legacy' | 'local'; startedAt: string | null }
  previousError?: { message: string; recordedAt: string | null; origin: 'legacy' | 'local' } | null
  phase: 'idle' | 'queued' | 'running' | 'paused' | 'finished' | 'failed'
  asOf: string | null
  latestCompleteDate: string | null
  total: number
  checked: number
  completed: number
  failed: number
  updatedAt: string | null
  availableAt: string | null
  error: string | null
  samples: Array<{ code: string; reason: string }>
  financial?: { checked: number; completed: number; failed: number; samples: Array<{ code: string; reason: string }> }
  reused?: { daily: number; financial: number }
  sources?: Array<{ source: string; adjustment: string; count: number; oldestDate: string; newestDate: string; fetchedAt: string }>
  limitPools?: { requested: number; available: number; missingDates: string[] }
}
