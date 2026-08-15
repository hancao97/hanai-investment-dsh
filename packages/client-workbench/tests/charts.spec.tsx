// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { KlineChart, Sparkline, TrendChart } from '../src/charts.tsx'
import type { KLineBar, TrendPoint } from '../../contracts/src/index.ts'

afterEach(cleanup)

const TREND: TrendPoint[] = [
  { time: '09:30', price: 10, avgPrice: 10, volume: 1_200 },
  { time: '10:30', price: 10.2, avgPrice: null, volume: 2_400 },
  { time: '14:58', price: 10.1, avgPrice: 10.08, volume: 1_800 },
]

const BARS: KLineBar[] = [
  { date: '2026-01-02', open: 10, high: 10.8, low: 9.9, close: 10.6, volume: 12_000, amount: 126_000 },
  { date: '2026-01-03', open: 10.6, high: 10.7, low: 10.1, close: 10.2, volume: 9_000, amount: null },
  { date: '2026-01-04', open: 10.2, high: 10.5, low: 10, close: 10.4, volume: 10_500, amount: 108_000 },
]

describe('research charts', () => {
  it('can move from an empty loading state to real chart data without changing hook order', () => {
    const trend = render(<TrendChart points={[]} />)
    trend.rerender(<TrendChart points={TREND} />)
    expect(screen.getByRole('img', { name: '股票分时价格、均价与成交量图' })).toBeInTheDocument()
    trend.unmount()

    const sparkline = render(<Sparkline values={[]} />)
    sparkline.rerender(<Sparkline values={[1, 2, 3]} />)
    expect(screen.getByRole('img', { name: '走势折线图' })).toBeInTheDocument()
  })

  it('renders real time labels, previous close, volume, and keyboard-readable trend values', () => {
    const { container } = render(<TrendChart points={TREND} prevClose={9.95} />)
    const chart = screen.getByRole('img', { name: '股票分时价格、均价与成交量图' })

    expect(container).toHaveTextContent('09:30')
    expect(container).toHaveTextContent('14:58')
    expect(container.querySelector('[data-previous-close="true"]')).toHaveTextContent('昨收 9.950')
    expect(container.querySelectorAll('[data-volume-bar="trend"]')).toHaveLength(3)

    const averagePath = container.querySelector('[data-series="average"]')?.getAttribute('d') ?? ''
    expect(averagePath.match(/M/g)).toHaveLength(2)

    fireEvent.focus(chart)
    fireEvent.keyDown(chart, { key: 'Home' })
    expect(screen.getByRole('status')).toHaveTextContent('09:30')
    expect(screen.getByRole('status')).toHaveTextContent('价格 10.00')
    expect(screen.getByRole('status')).toHaveTextContent('成交量 1,200')
  })

  it('renders real dates and exposes OHLC, amount, and volume without filling missing amount', () => {
    const { container } = render(<KlineChart bars={BARS} />)
    const chart = screen.getByRole('img', { name: '股票 K 线、成交量与开高低收数据图' })

    expect(container).toHaveTextContent('01-02')
    expect(container).toHaveTextContent('01-04')
    expect(container.querySelectorAll('[data-volume-bar="kline"]')).toHaveLength(3)

    fireEvent.focus(chart)
    fireEvent.keyDown(chart, { key: 'Home' })
    expect(screen.getByRole('status')).toHaveTextContent('2026-01-02')
    expect(screen.getByRole('status')).toHaveTextContent('开 10.00')
    expect(screen.getByRole('status')).toHaveTextContent('高 10.80')
    expect(screen.getByRole('status')).toHaveTextContent('低 9.900')
    expect(screen.getByRole('status')).toHaveTextContent('收 10.60')
    expect(screen.getByRole('status')).toHaveTextContent('量 1.20万')
    expect(screen.getByRole('status')).toHaveTextContent('额 12.60万')

    fireEvent.keyDown(chart, { key: 'ArrowRight' })
    expect(screen.getByRole('status')).toHaveTextContent('2026-01-03')
    expect(screen.getByRole('status')).not.toHaveTextContent('额')
  })
})
