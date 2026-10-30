// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { PanelHead, PanelDataMeta } from '../src/panel-head.tsx'

afterEach(cleanup)
const meta = { providerId: 'test', sourceName: '测试来源', sourceTimestamp: '2026-10-27', fetchedAt: '2026-10-27T08:00:00Z', cacheState: 'cached' as const }

describe('shared panel header', () => {
  it('keeps historical state, source dates and actions inside one header', () => {
    const { container } = render(<article><PanelHead title="市场宽度" hint="统计口径" meta={<PanelDataMeta meta={meta} history />} extra={<button>刷新</button>} /><div>业务数据</div></article>)
    const header = screen.getByRole('heading', { name: '市场宽度' }).closest('header')!
    expect(within(header).getByText('历史快照')).toBeTruthy()
    expect(within(header).getByText(/测试来源 · 交易日 2026-10-27 · 获取于/)).toBeTruthy()
    expect(within(header).getByRole('button', { name: '刷新' })).toBeTruthy()
    expect(screen.getByText('业务数据').closest('header')).toBeNull()
    expect(container.querySelectorAll('[data-panel-head]')).toHaveLength(1)
  })
  it('retains unavailable provenance and attempt time without treating it as successful data', () => {
    render(<PanelHead title="行情" meta={<PanelDataMeta meta={{ ...meta, cacheState: 'unavailable' }} />} />)
    const header = screen.getByRole('heading').closest('header')!
    expect(header.querySelector('[data-data-status="unavailable"]')).toBeTruthy()
    expect(within(header).getByText(/测试来源.*尝试于/)).toBeTruthy()
  })
  it('gives failed refresh priority over a resting archive', () => {
    render(<PanelHead title="行情" meta={<PanelDataMeta meta={meta} resting refreshFailed />} />)
    expect(screen.getByText('刷新失败')).toBeTruthy()
    expect(screen.queryByText('休市快照')).toBeNull()
  })
  it('preserves report-period semantics when showing financial snapshot dates', () => {
    render(<PanelHead title="季度规模" meta={<PanelDataMeta meta={meta} liveCapable={false} dateLabel="报告期" />} />)
    expect(screen.getByText(/报告期 2026-10-27/).closest('header')).toBeTruthy()
    expect(screen.queryByText(/交易日/)).toBeNull()
  })
})
