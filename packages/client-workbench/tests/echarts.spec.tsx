// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const echartsMock = vi.hoisted(() => {
  const chart = {
    on: vi.fn(),
    off: vi.fn(),
    setOption: vi.fn(),
    clear: vi.fn(),
    resize: vi.fn(),
    dispose: vi.fn(),
  }
  return {
    chart,
    init: vi.fn(() => chart),
    use: vi.fn(),
  }
})

const runtimeGate = vi.hoisted(() => {
  let release = (): void => undefined
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
})

vi.mock('echarts/core', async () => {
  await runtimeGate.promise
  return {
    init: echartsMock.init,
    use: echartsMock.use,
  }
})
vi.mock('echarts/charts', () => ({
  BarChart: {},
  CandlestickChart: {},
  LineChart: {},
  RadarChart: {},
  TreemapChart: {},
}))
vi.mock('echarts/components', () => ({
  AxisPointerComponent: {},
  DataZoomComponent: {},
  GridComponent: {},
  LegendComponent: {},
  MarkLineComponent: {},
  TooltipComponent: {},
}))
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }))

import { EChart } from '../src/echarts.tsx'

class ResizeObserverMock {
  static instances: ResizeObserverMock[] = []
  readonly observe = vi.fn()
  readonly disconnect = vi.fn()

  constructor(readonly callback: ResizeObserverCallback) {
    ResizeObserverMock.instances.push(this)
  }
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverMock)
  ResizeObserverMock.instances = []
  echartsMock.chart.on.mockClear()
  echartsMock.chart.off.mockClear()
  echartsMock.chart.setOption.mockClear()
  echartsMock.chart.clear.mockClear()
  echartsMock.chart.resize.mockClear()
  echartsMock.chart.dispose.mockClear()
  echartsMock.init.mockClear()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('EChart', () => {
  it('loads only after mount, applies the latest option, and ignores an instance unmounted while loading', async () => {
    const first = { series: [{ type: 'line', data: [1] }] }
    const latest = { series: [{ type: 'line', data: [2] }] }
    const survivor = render(<EChart option={first} ariaLabel="survivor" />)
    const cancelled = render(<EChart option={first} ariaLabel="cancelled" />)
    survivor.rerender(<EChart option={latest} ariaLabel="survivor" />)
    cancelled.unmount()

    expect(echartsMock.init).not.toHaveBeenCalled()
    await act(async () => {
      runtimeGate.release()
      await runtimeGate.promise
    })
    await waitFor(() => expect(echartsMock.init).toHaveBeenCalledTimes(1))
    expect(echartsMock.init).toHaveBeenCalledWith(screen.getByRole('img', { name: 'survivor' }))
    expect(echartsMock.chart.setOption).toHaveBeenLastCalledWith(latest, { notMerge: true })
  })

  it('initializes once, replaces options, resizes and disposes with the host element', async () => {
    const first = { series: [{ type: 'line', data: [1] }] }
    const second = { series: [{ type: 'line', data: [2] }] }
    const view = render(<EChart option={first} ariaLabel="价格走势" className="external" />)
    const element = screen.getByRole('img', { name: '价格走势' })

    expect(element).toHaveClass('external')
    await waitFor(() => expect(echartsMock.init).toHaveBeenCalledTimes(1))
    expect(echartsMock.init).toHaveBeenCalledWith(element)
    expect(echartsMock.chart.setOption).toHaveBeenLastCalledWith(first, { notMerge: true })
    expect(ResizeObserverMock.instances[0]?.observe).toHaveBeenCalledWith(element)

    view.rerender(<EChart option={second} ariaLabel="价格走势" className="external" />)
    expect(echartsMock.init).toHaveBeenCalledTimes(1)
    expect(echartsMock.chart.setOption).toHaveBeenLastCalledWith(second, { notMerge: true })

    view.rerender(<EChart option={null} ariaLabel="价格走势" className="external" />)
    expect(echartsMock.chart.clear).toHaveBeenCalledTimes(1)

    ResizeObserverMock.instances[0]?.callback([], ResizeObserverMock.instances[0] as unknown as ResizeObserver)
    expect(echartsMock.chart.resize).toHaveBeenCalledTimes(1)

    view.unmount()
    expect(ResizeObserverMock.instances[0]?.disconnect).toHaveBeenCalledTimes(1)
    expect(echartsMock.chart.off).toHaveBeenCalledWith('click', expect.any(Function))
    expect(echartsMock.chart.dispose).toHaveBeenCalledTimes(1)
  })

  it('forwards both canvas clicks and interactive Other-tooltip rows through one contract', async () => {
    const onChartClick = vi.fn()
    render(<EChart option={{ series: [] }} onChartClick={onChartClick} />)
    await waitFor(() => expect(echartsMock.chart.on).toHaveBeenCalled())
    const chartListener = echartsMock.chart.on.mock.calls.find(([event]) => event === 'click')?.[1] as
      | ((params: unknown) => void)
      | undefined
    chartListener?.({ data: { sectorCode: 'BK001', name: '电子' } })
    expect(onChartClick).toHaveBeenLastCalledWith({ data: { sectorCode: 'BK001', name: '电子' } })

    const element = screen.getByRole('img', { name: '数据图表' })
    const button = document.createElement('button')
    button.dataset.sectorCode = 'BK002'
    button.dataset.sectorName = '半导体'
    element.append(button)
    fireEvent.click(button)
    expect(onChartClick).toHaveBeenLastCalledWith({ data: { sectorCode: 'BK002', name: '半导体' } })
  })

  it('forwards axis-pointer updates for fixed chart inspectors', async () => {
    const onAxisPointerUpdate = vi.fn()
    const onPointerLeave = vi.fn()
    const view = render(<EChart option={{ series: [] }} onAxisPointerUpdate={onAxisPointerUpdate} onPointerLeave={onPointerLeave} />)
    await waitFor(() => expect(echartsMock.chart.on).toHaveBeenCalledWith('updateAxisPointer', expect.any(Function)))
    const listener = echartsMock.chart.on.mock.calls.find(([event]) => event === 'updateAxisPointer')?.[1] as
      | ((params: unknown) => void)
      | undefined
    const event = { axesInfo: [{ axisDim: 'x', axisIndex: 0, value: '2026-08-15' }] }
    listener?.(event)
    expect(onAxisPointerUpdate).toHaveBeenCalledWith(event)
    fireEvent.mouseLeave(screen.getByRole('img', { name: '数据图表' }))
    expect(onPointerLeave).toHaveBeenCalledTimes(1)

    view.unmount()
    expect(echartsMock.chart.off).toHaveBeenCalledWith('updateAxisPointer', expect.any(Function))
  })
})
