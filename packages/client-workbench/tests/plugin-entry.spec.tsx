// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('../src/api.ts', () => ({ HanaiClient: class {} }))
vi.mock('../src/app.tsx', () => ({
  HanaiWorkbench: ({ onClose }: { onClose: () => void }) => <button onClick={onClose}>返回 DSH</button>,
}))
import { apply, inject } from '../src/index.tsx'

afterEach(cleanup)

it('adds a sidebar panel, mounts only on selection, and returns without changing the session URL', () => {
  const registrations: Array<{ config: Record<string, unknown>; Component: () => React.ReactNode }> = []
  const selectPanel = vi.fn()
  const ctx = {
    layout: { selectPanel },
    slots: {
      inject: vi.fn((_name, register: () => unknown) => register()),
      register: vi.fn((config, Component) => { registrations.push({ config, Component }) }),
    },
  }
  window.history.replaceState(null, '', '#/session/original')
  apply(ctx as unknown as Context)
  expect(inject).toContain('layout')
  expect(screen.queryByRole('button', { name: '返回 DSH' })).toBeNull()
  expect(registrations.map(entry => entry.config.name)).toEqual(['main', 'sidebar.panellist'])
  expect(registrations[0]?.config.key).toBe(registrations[1]?.config.id)
  const Panel = registrations[0]!.Component
  const view = render(<Panel />)
  fireEvent.click(screen.getByRole('button', { name: '返回 DSH' }))
  expect(selectPanel).toHaveBeenCalledWith(null)
  expect(window.location.hash).toBe('#/session/original')
  view.unmount()
  expect(screen.queryByRole('button', { name: '返回 DSH' })).toBeNull()
})
