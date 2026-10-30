import { useEffect, useState } from 'react'

/**
 * 判断给定时刻是否处于 A 股开市时段。
 * 北京时间（UTC+8）周一至周五 09:25–15:05；集合竞价尾段与收盘缓冲计入，
 * 收盘后即视为闭市，前端轮询据此停发行情请求。
 * 用 UTC 分量显式换算，不依赖宿主机时区设置。
 */
export { isMarketOpen, isMarketResting } from '../../contracts/src/market-hours.ts'

/**
 * 手动刷新冷却：触发后 `seconds` 秒内 canRefresh 为 false。
 * 只用于按钮交互防抖；自动轮询不得读取此状态，避免误挡行情更新。
 */
export function useRefreshCooldown(seconds = 60): {
  cooldown: number
  canRefresh: boolean
  startCooldown: () => void
} {
  const [cooldown, setCooldown] = useState(0)
  useEffect(() => {
    if (cooldown <= 0) return
    const timer = window.setInterval(() => {
      setCooldown(value => (value > 0 ? value - 1 : 0))
    }, 1_000)
    return () => window.clearInterval(timer)
  }, [cooldown > 0])
  return {
    cooldown,
    canRefresh: cooldown <= 0,
    startCooldown: () => { if (cooldown <= 0) setCooldown(seconds) },
  }
}
