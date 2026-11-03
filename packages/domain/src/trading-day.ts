/** Host-side seam for the intraday trading-data providers. */
import type {
  TradingDayAnalysisData,
  TradingDayContextData,
  TradingDayDragonTigerData,
  TradingDayLimitPoolsData,
  TradingDayThemesData,
} from '../../contracts/src/index.ts'

export interface TradingDayFacade {
  tradingDayContext(): Promise<TradingDayContextData>
  tradingDayLimitPools(): Promise<TradingDayLimitPoolsData>
  tradingDayThemes(): Promise<TradingDayThemesData>
  tradingDayDragonTiger(): Promise<TradingDayDragonTigerData>
  tradingDayAnalysis(): Promise<TradingDayAnalysisData>
}
