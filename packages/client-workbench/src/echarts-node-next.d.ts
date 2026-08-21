/**
 * ECharts 5.6 publishes extensionless re-exports in its subpath declarations,
 * which TypeScript's NodeNext resolver cannot follow. Keep the small runtime
 * surface used by this client explicit until ECharts ships NodeNext-safe types.
 */
declare module 'echarts/core' {
  export type EChartsCoreOption = Record<string, unknown>

  export interface ECharts {
    on(event: 'click', handler: (params: unknown) => void): void
    off(event: 'click', handler: (params: unknown) => void): void
    setOption(option: EChartsCoreOption, options?: { notMerge?: boolean }): void
    clear(): void
    resize(): void
    dispose(): void
  }

  export function init(element: HTMLElement): ECharts
  export function use(extensions: unknown[]): void
}

declare module 'echarts/charts' {
  export const TreemapChart: unknown
  export const LineChart: unknown
  export const BarChart: unknown
  export const CandlestickChart: unknown
  export const RadarChart: unknown
}

declare module 'echarts/components' {
  export const TooltipComponent: unknown
  export const GridComponent: unknown
  export const LegendComponent: unknown
  export const DataZoomComponent: unknown
  export const AxisPointerComponent: unknown
  export const MarkLineComponent: unknown
}

declare module 'echarts/renderers' {
  export const CanvasRenderer: unknown
}
