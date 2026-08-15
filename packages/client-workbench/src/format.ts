export function money(value: number | null, digits = 2): string {
  if (value === null || !Number.isFinite(value)) return '—'
  const abs = Math.abs(value)
  if (abs >= 1e12) return `${(value / 1e12).toFixed(digits)}万亿`
  if (abs >= 1e8) return `${(value / 1e8).toFixed(digits)}亿`
  if (abs >= 1e4) return `${(value / 1e4).toFixed(digits)}万`
  return value.toLocaleString('zh-CN', { maximumFractionDigits: digits })
}

export function quantity(value: number | null, digits = 2): string {
  if (value === null || !Number.isFinite(value)) return '—'
  const abs = Math.abs(value)
  if (abs >= 1e8) return `${(value / 1e8).toFixed(digits)}亿`
  if (abs >= 1e4) return `${(value / 1e4).toFixed(digits)}万`
  return value.toLocaleString('zh-CN', { maximumFractionDigits: digits })
}

export function number(value: number | null, digits = 2): string {
  return value === null || !Number.isFinite(value) ? '—' : value.toLocaleString('zh-CN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}

export function percent(value: number | null, digits = 2): string {
  return value === null || !Number.isFinite(value) ? '—' : `${value >= 0 ? '+' : ''}${value.toFixed(digits)}%`
}

export function ratio(value: number | null, digits = 2): string {
  return value === null || !Number.isFinite(value) ? '—' : `${value.toFixed(digits)}%`
}

export function dateTime(value: string | null): string {
  if (value === null) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  })
}

export function classForChange(value: number | null): 'up' | 'down' | 'flat' {
  if (value === null || value === 0) return 'flat'
  return value > 0 ? 'up' : 'down'
}
