#!/usr/bin/env python3
"""Reproducible A-share K-line signal research baseline.

This script is intentionally separate from the product runtime.  It downloads
front-adjusted daily bars from BaoStock, evaluates only causal rules, executes
orders at the next trading day's open, applies A-share trading constraints and
cost assumptions, and emits an auditable JSON result (without redistributing
the vendor's raw market data).

Install the single research-only dependency in an isolated environment:

    python -m venv /tmp/hanai-signal-research
    /tmp/hanai-signal-research/bin/pip install baostock
    /tmp/hanai-signal-research/bin/python \
      scripts/research/kline-signal-backtest.py \
      --output docs/research-data/kline-signal-backtest-2026-08-21.json
"""

from __future__ import annotations

import argparse
import dataclasses
import datetime as dt
import hashlib
import json
import math
import random
import statistics
import sys
import time
from collections import defaultdict
from pathlib import Path
from typing import Any, Iterable, Sequence

try:
    import baostock as bs
except ImportError as error:  # pragma: no cover - exercised by operators
    raise SystemExit("Missing research dependency: pip install baostock") from error


SYMBOLS: tuple[tuple[str, str, str], ...] = (
    ("sh.600519", "贵州茅台", "消费"),
    ("sz.000858", "五粮液", "消费"),
    ("sh.601318", "中国平安", "保险"),
    ("sh.600036", "招商银行", "银行"),
    ("sh.600276", "恒瑞医药", "医药"),
    ("sz.000333", "美的集团", "家电"),
    ("sz.002594", "比亚迪", "汽车"),
    ("sz.300750", "宁德时代", "新能源"),
    ("sh.600900", "长江电力", "公用事业"),
    ("sh.600030", "中信证券", "证券"),
    ("sz.000001", "平安银行", "银行"),
    ("sh.600436", "片仔癀", "医药"),
    ("sh.603288", "海天味业", "消费"),
    ("sh.601012", "隆基绿能", "新能源"),
    ("sz.002415", "海康威视", "科技"),
    ("sh.600031", "三一重工", "机械"),
    ("sz.000651", "格力电器", "家电"),
    ("sz.300059", "东方财富", "金融科技"),
    ("sh.601888", "中国中免", "消费"),
    ("sh.600809", "山西汾酒", "消费"),
    ("sh.601398", "工商银行", "银行"),
    ("sh.601857", "中国石油", "能源"),
    ("sh.600104", "上汽集团", "汽车"),
    ("sz.000725", "京东方A", "电子"),
    ("sz.002230", "科大讯飞", "科技"),
    ("sh.600887", "伊利股份", "消费"),
    ("sz.002304", "洋河股份", "消费"),
    ("sh.600585", "海螺水泥", "材料"),
    ("sz.000895", "双汇发展", "消费"),
    ("sh.601899", "紫金矿业", "有色金属"),
)

COHORT_DATES: dict[int, str] = {
    2015: "2015-01-05",
    2021: "2021-01-04",
    2022: "2022-01-04",
    2023: "2023-01-03",
    2024: "2024-01-02",
    2025: "2025-01-02",
    2026: "2026-01-05",
}

FIELDS = (
    "date,code,open,high,low,close,preclose,volume,amount,turn,pctChg,isST"
)
BUY_COMMISSION = 0.0003
SELL_COMMISSION = 0.0003
TRANSFER_FEE = 0.00001
SELL_STAMP_DUTY = 0.0005
SLIPPAGE = 0.001
BUY_COST = BUY_COMMISSION + TRANSFER_FEE
SELL_COST = SELL_COMMISSION + TRANSFER_FEE + SELL_STAMP_DUTY


@dataclasses.dataclass(frozen=True)
class Bar:
    date: dt.date
    code: str
    open: float
    high: float
    low: float
    close: float
    preclose: float
    volume: float
    amount: float | None
    turnover: float | None
    pct_change: float
    is_st: bool


@dataclasses.dataclass(frozen=True)
class StrategySpec:
    family: str
    params: dict[str, float | int | bool]

    @property
    def key(self) -> str:
        bits = ",".join(f"{key}={self.params[key]}" for key in sorted(self.params))
        return f"{self.family}[{bits}]"


@dataclasses.dataclass
class Trade:
    symbol: str
    family: str
    spec_key: str
    entry_signal_date: dt.date
    entry_date: dt.date
    entry_index: int
    entry_price: float
    exit_signal_date: dt.date
    exit_date: dt.date
    exit_index: int
    exit_price: float
    hold_days: int
    net_return: float
    exit_reason: str


@dataclasses.dataclass
class Simulation:
    trades: list[Trade]
    signals: list[int]
    sell_signals: list[int]
    daily_equity: list[tuple[dt.date, float]]
    skipped_limit_up: int
    delayed_limit_down: int


def parse_number(raw: str) -> float | None:
    if raw == "":
        return None
    value = float(raw)
    return value if math.isfinite(value) else None


def fetch_bars(
    symbol: str,
    start: str,
    end: str,
    cache_dir: Path,
    refresh: bool,
) -> list[Bar]:
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_path = cache_dir / f"{symbol.replace('.', '-')}-{start}-{end}-qfq.json"
    if cache_path.exists() and not refresh:
        rows = json.loads(cache_path.read_text(encoding="utf-8"))
    else:
        result = bs.query_history_k_data_plus(
            symbol,
            FIELDS,
            start_date=start,
            end_date=end,
            frequency="d",
            adjustflag="2",  # BaoStock: 2 = front adjusted / 前复权.
        )
        if result.error_code != "0":
            raise RuntimeError(f"BaoStock {symbol}: {result.error_code} {result.error_msg}")
        rows: list[list[str]] = []
        while result.next():
            rows.append(result.get_row_data())
        cache_path.write_text(json.dumps(rows, ensure_ascii=False), encoding="utf-8")
        time.sleep(0.08)

    bars: list[Bar] = []
    for row in rows:
        if len(row) != 12:
            continue
        numeric = [parse_number(value) for value in row[2:8]]
        if any(value is None for value in numeric):
            continue
        open_price, high, low, close, preclose, volume = (
            float(value) for value in numeric if value is not None
        )
        if min(open_price, high, low, close, preclose) <= 0:
            continue
        bars.append(
            Bar(
                date=dt.date.fromisoformat(row[0]),
                code=row[1],
                open=open_price,
                high=high,
                low=low,
                close=close,
                preclose=preclose,
                volume=volume,
                amount=parse_number(row[8]),
                turnover=parse_number(row[9]),
                pct_change=float(row[10]),
                is_st=row[11] == "1",
            )
        )
    return bars


def query_index_constituents(
    query: Any, snapshot: str, label: str
) -> list[tuple[str, str, str]]:
    result = query(snapshot)
    if result.error_code != "0":
        raise RuntimeError(
            f"BaoStock {label} constituents at {snapshot}: "
            f"{result.error_code} {result.error_msg}"
        )
    rows: list[tuple[str, str, str]] = []
    while result.next():
        row = result.get_row_data()
        if len(row) >= 3 and row[1] and row[2]:
            rows.append((row[1], row[2], label))
    return rows


def deterministic_sample(
    rows: Sequence[tuple[str, str, str]], snapshot: str, size: int
) -> list[tuple[str, str, str]]:
    return sorted(
        rows,
        key=lambda row: hashlib.sha256(
            f"{snapshot}|{row[2]}|{row[0]}".encode()
        ).hexdigest(),
    )[:size]


def point_in_time_cohorts(
    per_index: int,
) -> tuple[dict[int, set[str]], dict[str, dict[str, Any]]]:
    cohorts: dict[int, set[str]] = {}
    registry: dict[str, dict[str, Any]] = {}
    for year, snapshot in COHORT_DATES.items():
        selected = [
            *deterministic_sample(
                query_index_constituents(bs.query_hs300_stocks, snapshot, "沪深300"),
                snapshot,
                per_index,
            ),
            *deterministic_sample(
                query_index_constituents(bs.query_zz500_stocks, snapshot, "中证500"),
                snapshot,
                per_index,
            ),
        ]
        cohorts[year] = {symbol for symbol, _, _ in selected}
        for symbol, name, index_name in selected:
            item = registry.setdefault(
                symbol,
                {"name": name, "index_snapshots": defaultdict(list)},
            )
            item["name"] = name
            item["index_snapshots"][index_name].append(snapshot)
    normalized_registry = {
        symbol: {
            "name": item["name"],
            "index_snapshots": {
                key: sorted(value) for key, value in item["index_snapshots"].items()
            },
        }
        for symbol, item in registry.items()
    }
    return cohorts, normalized_registry


def sma(values: Sequence[float], period: int) -> list[float | None]:
    result: list[float | None] = [None] * len(values)
    running = 0.0
    for index, value in enumerate(values):
        running += value
        if index >= period:
            running -= values[index - period]
        if index >= period - 1:
            result[index] = running / period
    return result


def rolling_max(values: Sequence[float], period: int) -> list[float | None]:
    result: list[float | None] = [None] * len(values)
    for index in range(period, len(values)):
        result[index] = max(values[index - period : index])
    return result


def indicators(bars: Sequence[Bar]) -> dict[str, list[float | None]]:
    closes = [bar.close for bar in bars]
    volumes = [bar.volume for bar in bars]
    highs = [bar.high for bar in bars]
    return {
        "ma5": sma(closes, 5),
        "ma10": sma(closes, 10),
        "ma20": sma(closes, 20),
        "ma60": sma(closes, 60),
        "vol20": sma(volumes, 20),
        "high20": rolling_max(highs, 20),
        "high40": rolling_max(highs, 40),
    }


def all_values(*values: float | None) -> bool:
    return all(value is not None and math.isfinite(value) for value in values)


def volume_ok(bar: Bar, avg_volume: float | None, threshold: float) -> bool:
    return threshold <= 0 or (
        avg_volume is not None and avg_volume > 0 and bar.volume / avg_volume >= threshold
    )


def limit_ratio(bar: Bar) -> float:
    if bar.is_st:
        return 0.05
    code = bar.code.split(".")[-1]
    if code.startswith(("688", "300")):
        return 0.20
    if code.startswith(("8", "4")):
        return 0.30
    return 0.10


def unavailable_at_limit(bar: Bar, side: str) -> bool:
    ratio = limit_ratio(bar)
    tolerance = max(0.01, bar.preclose * 0.0005)
    if side == "buy":
        return bar.open >= bar.preclose * (1 + ratio) - tolerance
    return bar.open <= bar.preclose * (1 - ratio) + tolerance


def entry_exit_flags(
    bars: Sequence[Bar],
    values: dict[str, list[float | None]],
    spec: StrategySpec,
) -> tuple[list[bool], list[bool]]:
    entry = [False] * len(bars)
    exit_ = [False] * len(bars)
    p = spec.params

    if spec.family == "ma_cross":
        volume_threshold = float(p["volume"])
        trend_filter = bool(p["trend_filter"])
        for i in range(60, len(bars)):
            ma5, ma10 = values["ma5"][i], values["ma10"][i]
            pre5, pre10 = values["ma5"][i - 1], values["ma10"][i - 1]
            ma20, ma60 = values["ma20"][i], values["ma60"][i]
            if not all_values(ma5, ma10, pre5, pre10, ma20, ma60):
                continue
            entry[i] = (
                ma5 > ma10
                and pre5 <= pre10
                and (not trend_filter or (bars[i].close > ma60 and ma20 > ma60))
                and volume_ok(bars[i], values["vol20"][i], volume_threshold)
            )
            exit_[i] = ma5 < ma10 or bars[i].close < ma20

    elif spec.family == "trend_pullback":
        volume_threshold = float(p["volume"])
        for i in range(61, len(bars)):
            ma20, ma60 = values["ma20"][i], values["ma60"][i]
            pre20, pre60 = values["ma20"][i - 1], values["ma60"][i - 1]
            if not all_values(ma20, ma60, pre20, pre60):
                continue
            touched = min(bar.low for bar in bars[i - 4 : i + 1]) <= ma20 * 1.02
            entry[i] = (
                ma20 > ma60
                and bars[i].close > ma20
                and bars[i - 1].close <= pre20
                and touched
                and volume_ok(bars[i], values["vol20"][i], volume_threshold)
            )
            exit_[i] = (
                (bars[i].close < ma20 and bars[i - 1].close < pre20)
                or ma20 < ma60
            )

    elif spec.family == "volume_breakout":
        lookback = int(p["lookback"])
        volume_threshold = float(p["volume"])
        high_key = f"high{lookback}"
        for i in range(max(60, lookback), len(bars)):
            ma10, ma20, ma60 = values["ma10"][i], values["ma20"][i], values["ma60"][i]
            prior_high = values[high_key][i]
            if not all_values(ma10, ma20, ma60, prior_high):
                continue
            entry[i] = (
                bars[i].close > prior_high
                and ma20 > ma60
                and volume_ok(bars[i], values["vol20"][i], volume_threshold)
            )
            exit_[i] = bars[i].close < ma10 or ma20 < ma60

    elif spec.family == "center_retest_proxy":
        # This is a causal breakout/retest proxy, not a claim of a full Chan B3.
        lookback = int(p["lookback"])
        volume_threshold = float(p["volume"])
        tolerance = float(p["tolerance"])
        retest_days = int(p["retest_days"])
        high_key = f"high{lookback}"
        active_level: float | None = None
        breakout_index: int | None = None
        for i in range(max(60, lookback), len(bars)):
            ma20, ma60 = values["ma20"][i], values["ma60"][i]
            prior_high = values[high_key][i]
            if not all_values(ma20, ma60, prior_high):
                continue
            if (
                bars[i].close > prior_high
                and ma20 > ma60
                and volume_ok(bars[i], values["vol20"][i], volume_threshold)
            ):
                active_level = float(prior_high)
                breakout_index = i
            elif active_level is not None and breakout_index is not None:
                age = i - breakout_index
                if age > retest_days or bars[i].close < active_level * (1 - tolerance):
                    active_level = None
                    breakout_index = None
                elif (
                    age >= 1
                    and bars[i].low <= active_level * (1 + tolerance)
                    and bars[i].close >= active_level
                    and bars[i].close >= ma20
                ):
                    entry[i] = True
                    active_level = None
                    breakout_index = None
            exit_[i] = bars[i].close < ma20 or ma20 < ma60
    else:  # pragma: no cover - guarded by the fixed grid
        raise ValueError(spec.family)

    return entry, exit_


def simulate(symbol: str, bars: Sequence[Bar], spec: StrategySpec) -> Simulation:
    values = indicators(bars)
    entry_flags, exit_flags = entry_exit_flags(bars, values, spec)
    max_hold = int(spec.params.get("max_hold", 40))
    trades: list[Trade] = []
    signals: list[int] = []
    sell_signals: list[int] = []
    daily_equity: list[tuple[dt.date, float]] = []
    skipped_limit_up = 0
    delayed_limit_down = 0
    cash = 1.0
    shares = 0.0
    entry_signal_index: int | None = None
    entry_index: int | None = None
    entry_raw_price: float | None = None
    entry_effective_price: float | None = None
    pending_exit: tuple[int, str] | None = None
    pending_entry_signal: int | None = None

    for i, bar in enumerate(bars):
        if pending_exit is not None and shares > 0 and entry_index is not None:
            if unavailable_at_limit(bar, "sell"):
                delayed_limit_down += 1
            else:
                signal_index, reason = pending_exit
                exit_effective = bar.open * (1 - SLIPPAGE) * (1 - SELL_COST)
                cash = shares * exit_effective
                assert entry_signal_index is not None
                assert entry_raw_price is not None
                assert entry_effective_price is not None
                trades.append(
                    Trade(
                        symbol=symbol,
                        family=spec.family,
                        spec_key=spec.key,
                        entry_signal_date=bars[entry_signal_index].date,
                        entry_date=bars[entry_index].date,
                        entry_index=entry_index,
                        entry_price=entry_raw_price,
                        exit_signal_date=bars[signal_index].date,
                        exit_date=bar.date,
                        exit_index=i,
                        exit_price=bar.open,
                        hold_days=i - entry_index,
                        net_return=exit_effective / entry_effective_price - 1,
                        exit_reason=reason,
                    )
                )
                shares = 0.0
                entry_signal_index = None
                entry_index = None
                entry_raw_price = None
                entry_effective_price = None
                pending_exit = None

        if pending_entry_signal is not None and shares == 0 and pending_exit is None:
            if unavailable_at_limit(bar, "buy"):
                skipped_limit_up += 1
            else:
                entry_signal_index = pending_entry_signal
                entry_index = i
                entry_raw_price = bar.open
                entry_effective_price = bar.open * (1 + SLIPPAGE) / (1 - BUY_COST)
                shares = cash / entry_effective_price
                cash = 0.0
            pending_entry_signal = None

        equity = cash if shares == 0 else shares * bar.close
        daily_equity.append((bar.date, equity))

        if shares > 0 and entry_index is not None and pending_exit is None:
            if i > entry_index and exit_flags[i]:
                sell_signals.append(i)
                pending_exit = (i, "rule")
            elif i - entry_index >= max_hold:
                sell_signals.append(i)
                pending_exit = (i, "max_hold")
        elif shares == 0 and i + 1 < len(bars) and entry_flags[i]:
            signals.append(i)
            pending_entry_signal = i

    if shares > 0 and entry_index is not None:
        last = bars[-1]
        exit_effective = last.close * (1 - SLIPPAGE) * (1 - SELL_COST)
        cash = shares * exit_effective
        assert entry_signal_index is not None
        assert entry_raw_price is not None
        assert entry_effective_price is not None
        trades.append(
            Trade(
                symbol=symbol,
                family=spec.family,
                spec_key=spec.key,
                entry_signal_date=bars[entry_signal_index].date,
                entry_date=bars[entry_index].date,
                entry_index=entry_index,
                entry_price=entry_raw_price,
                exit_signal_date=last.date,
                exit_date=last.date,
                exit_index=len(bars) - 1,
                exit_price=last.close,
                hold_days=len(bars) - 1 - entry_index,
                net_return=exit_effective / entry_effective_price - 1,
                exit_reason="end_of_data",
            )
        )
        daily_equity[-1] = (last.date, cash)

    return Simulation(
        trades=trades,
        signals=signals,
        sell_signals=sell_signals,
        daily_equity=daily_equity,
        skipped_limit_up=skipped_limit_up,
        delayed_limit_down=delayed_limit_down,
    )


def max_drawdown(points: Iterable[tuple[dt.date, float]], start: dt.date, end: dt.date) -> float:
    peak = 0.0
    drawdown = 0.0
    first_value: float | None = None
    for date, value in points:
        if date < start or date > end:
            continue
        if first_value is None:
            first_value = value
        normalized = value / first_value if first_value and first_value > 0 else value
        peak = max(peak, normalized)
        if peak > 0:
            drawdown = max(drawdown, 1 - normalized / peak)
    return drawdown


def period_equity_return(
    points: Sequence[tuple[dt.date, float]], start: dt.date, end: dt.date
) -> tuple[float, float]:
    selected = [(date, value) for date, value in points if start <= date <= end]
    if len(selected) < 2 or selected[0][1] <= 0:
        return 0.0, 0.0
    total = selected[-1][1] / selected[0][1] - 1
    years = max((selected[-1][0] - selected[0][0]).days / 365.25, 1 / 365.25)
    cagr = (1 + total) ** (1 / years) - 1 if total > -1 else -1.0
    return total, cagr


def forward_return(
    trade: Trade, bars: Sequence[Bar], horizon: int
) -> float | None:
    target = trade.entry_index + horizon
    if target >= len(bars):
        return None
    exit_effective = bars[target].close * (1 - SLIPPAGE) * (1 - SELL_COST)
    entry_effective = trade.entry_price * (1 + SLIPPAGE) / (1 - BUY_COST)
    return exit_effective / entry_effective - 1


def avoided_return(
    signal_index: int, bars: Sequence[Bar], horizon: int
) -> float | None:
    exit_index = signal_index + 1
    target = exit_index + horizon
    if target >= len(bars):
        return None
    exit_effective = bars[exit_index].open * (1 - SLIPPAGE) * (1 - SELL_COST)
    hypothetical_reentry = bars[target].close * (1 + SLIPPAGE) / (1 - BUY_COST)
    return hypothetical_reentry / exit_effective - 1


def median(values: Sequence[float]) -> float:
    return statistics.median(values) if values else 0.0


def cluster_bootstrap(
    trades: Sequence[Trade], iterations: int = 2000
) -> dict[str, list[float] | None]:
    grouped: dict[str, list[Trade]] = defaultdict(list)
    for trade in trades:
        grouped[trade.symbol].append(trade)
    symbols = sorted(grouped)
    if not symbols or not trades:
        return {"win_rate_95ci": None, "mean_return_95ci": None}
    rng = random.Random(20260821)
    win_rates: list[float] = []
    means: list[float] = []
    for _ in range(iterations):
        sampled: list[Trade] = []
        for _ in symbols:
            sampled.extend(grouped[rng.choice(symbols)])
        if not sampled:
            continue
        returns = [trade.net_return for trade in sampled]
        win_rates.append(sum(value > 0 for value in returns) / len(returns))
        means.append(statistics.fmean(returns))
    win_rates.sort()
    means.sort()

    def bounds(values: Sequence[float]) -> list[float] | None:
        if not values:
            return None
        return [values[int(0.025 * (len(values) - 1))], values[int(0.975 * (len(values) - 1))]]

    return {"win_rate_95ci": bounds(win_rates), "mean_return_95ci": bounds(means)}


def summarize_period(
    simulations: dict[str, Simulation],
    bars_by_symbol: dict[str, list[Bar]],
    start: dt.date,
    end: dt.date,
    symbols: set[str] | None = None,
) -> dict[str, Any]:
    selected_symbols = set(simulations) if symbols is None else set(simulations) & symbols
    trades = [
        trade
        for symbol, simulation in simulations.items()
        if symbol in selected_symbols
        for trade in simulation.trades
        if start <= trade.entry_date <= end
    ]
    returns = [trade.net_return for trade in trades]
    symbol_cagrs: list[float] = []
    symbol_drawdowns: list[float] = []
    for symbol, simulation in simulations.items():
        if symbol not in selected_symbols:
            continue
        _, cagr = period_equity_return(simulation.daily_equity, start, end)
        symbol_cagrs.append(cagr)
        symbol_drawdowns.append(max_drawdown(simulation.daily_equity, start, end))

    forward: dict[str, dict[str, float | int | None]] = {}
    for horizon in (5, 10, 20):
        values: list[float] = []
        for trade in trades:
            result = forward_return(trade, bars_by_symbol[trade.symbol], horizon)
            if result is not None:
                values.append(result)
        forward[str(horizon)] = {
            "samples": len(values),
            "positive_rate": sum(value > 0 for value in values) / len(values) if values else None,
            "mean_return": statistics.fmean(values) if values else None,
            "median_return": median(values) if values else None,
        }

    sell_forward: list[float] = []
    for symbol, simulation in simulations.items():
        if symbol not in selected_symbols:
            continue
        bars = bars_by_symbol[symbol]
        for index in simulation.sell_signals:
            if not (start <= bars[index].date <= end):
                continue
            result = avoided_return(index, bars, 10)
            if result is not None:
                sell_forward.append(result)

    gross_profit = sum(value for value in returns if value > 0)
    gross_loss = -sum(value for value in returns if value < 0)
    return {
        "start": start.isoformat(),
        "end": end.isoformat(),
        "trades": len(trades),
        "win_rate": sum(value > 0 for value in returns) / len(returns) if returns else None,
        "mean_trade_return": statistics.fmean(returns) if returns else None,
        "median_trade_return": median(returns) if returns else None,
        "profit_factor": gross_profit / gross_loss if gross_loss > 0 else None,
        "median_symbol_cagr": median(symbol_cagrs),
        "median_symbol_max_drawdown": median(symbol_drawdowns),
        "forward_buy": forward,
        "sell_10d": {
            "samples": len(sell_forward),
            "avoided_decline_rate": sum(value < 0 for value in sell_forward) / len(sell_forward)
            if sell_forward
            else None,
            "mean_subsequent_return": statistics.fmean(sell_forward) if sell_forward else None,
        },
        "cluster_bootstrap": cluster_bootstrap(trades),
    }


def summarize_baseline(
    bars_by_symbol: dict[str, list[Bar]],
    start: dt.date,
    end: dt.date,
    symbols: set[str],
) -> dict[str, Any]:
    selected_symbols = set(bars_by_symbol) & symbols
    forward: dict[str, dict[str, float | int | None]] = {}
    for horizon in (5, 10, 20):
        returns: list[float] = []
        for symbol in selected_symbols:
            bars = bars_by_symbol[symbol]
            for signal_index, signal_bar in enumerate(bars):
                entry_index = signal_index + 1
                target_index = entry_index + horizon
                if not (start <= signal_bar.date <= end) or target_index >= len(bars):
                    continue
                if unavailable_at_limit(bars[entry_index], "buy"):
                    continue
                entry_effective = bars[entry_index].open * (1 + SLIPPAGE) / (1 - BUY_COST)
                exit_effective = bars[target_index].close * (1 - SLIPPAGE) * (1 - SELL_COST)
                returns.append(exit_effective / entry_effective - 1)
        forward[str(horizon)] = {
            "samples": len(returns),
            "positive_rate": sum(value > 0 for value in returns) / len(returns)
            if returns
            else None,
            "mean_return": statistics.fmean(returns) if returns else None,
            "median_return": median(returns) if returns else None,
        }

    total_returns: list[float] = []
    cagrs: list[float] = []
    drawdowns: list[float] = []
    for symbol in selected_symbols:
        bars = [bar for bar in bars_by_symbol[symbol] if start <= bar.date <= end]
        if len(bars) < 2:
            continue
        entry_effective = bars[0].open * (1 + SLIPPAGE) / (1 - BUY_COST)
        exit_effective = bars[-1].close * (1 - SLIPPAGE) * (1 - SELL_COST)
        total_return = exit_effective / entry_effective - 1
        years = max((bars[-1].date - bars[0].date).days / 365.25, 1 / 365.25)
        cagr = (1 + total_return) ** (1 / years) - 1 if total_return > -1 else -1.0
        peak = bars[0].close
        drawdown = 0.0
        for bar in bars:
            peak = max(peak, bar.close)
            drawdown = max(drawdown, 1 - bar.close / peak)
        total_returns.append(total_return)
        cagrs.append(cagr)
        drawdowns.append(drawdown)

    return {
        "unconditional_next_open_forward": forward,
        "buy_and_hold": {
            "symbols": len(cagrs),
            "median_total_return": median(total_returns),
            "median_cagr": median(cagrs),
            "median_max_drawdown": median(drawdowns),
        },
    }


def strategy_grid() -> list[StrategySpec]:
    specs: list[StrategySpec] = []
    for volume in (0.0, 1.0, 1.2):
        for trend_filter in (False, True):
            specs.append(
                StrategySpec(
                    "ma_cross",
                    {"volume": volume, "trend_filter": trend_filter, "max_hold": 40},
                )
            )
    for volume in (0.0, 0.8, 1.0):
        for max_hold in (20, 40):
            specs.append(
                StrategySpec("trend_pullback", {"volume": volume, "max_hold": max_hold})
            )
    for lookback in (20, 40):
        for volume in (1.2, 1.5):
            for max_hold in (20, 40):
                specs.append(
                    StrategySpec(
                        "volume_breakout",
                        {"lookback": lookback, "volume": volume, "max_hold": max_hold},
                    )
                )
    for lookback in (20, 40):
        for volume in (1.2, 1.5):
            for tolerance in (0.01, 0.02):
                for retest_days in (5, 10):
                    specs.append(
                        StrategySpec(
                            "center_retest_proxy",
                            {
                                "lookback": lookback,
                                "volume": volume,
                                "tolerance": tolerance,
                                "retest_days": retest_days,
                                "max_hold": 40,
                            },
                        )
                    )
    return specs


def selection_score(summary: dict[str, Any]) -> float:
    trades = int(summary["trades"])
    if trades < 60:
        return -10.0 + trades / 1000
    cagr = float(summary["median_symbol_cagr"])
    drawdown = float(summary["median_symbol_max_drawdown"])
    profit_factor = float(summary["profit_factor"] or 0)
    return cagr - 0.35 * drawdown + 0.02 * min(profit_factor, 3)


def date_range(year_start: int, year_end: int) -> tuple[dt.date, dt.date]:
    return dt.date(year_start, 1, 1), dt.date(year_end, 12, 31)


def round_floats(value: Any) -> Any:
    if isinstance(value, float):
        return round(value, 8) if math.isfinite(value) else None
    if isinstance(value, dict):
        return {key: round_floats(item) for key, item in value.items()}
    if isinstance(value, list):
        return [round_floats(item) for item in value]
    return value


def data_manifest(bars: Sequence[Bar]) -> dict[str, Any]:
    digest = hashlib.sha256()
    for bar in bars:
        digest.update(
            (
                f"{bar.date.isoformat()}|{bar.open:.8f}|{bar.high:.8f}|{bar.low:.8f}|"
                f"{bar.close:.8f}|{bar.volume:.4f}\n"
            ).encode()
        )
    return {
        "rows": len(bars),
        "first_date": bars[0].date.isoformat() if bars else None,
        "last_date": bars[-1].date.isoformat() if bars else None,
        "sha256": digest.hexdigest(),
    }


def run(args: argparse.Namespace) -> dict[str, Any]:
    login = bs.login()
    if login.error_code != "0":
        raise RuntimeError(f"BaoStock login failed: {login.error_code} {login.error_msg}")
    try:
        if args.universe_mode == "point-in-time":
            cohorts, registry = point_in_time_cohorts(args.cohort_per_index)
            requested_symbols = sorted(registry)
        else:
            cohorts = {
                year: {symbol for symbol, _, _ in SYMBOLS} for year in COHORT_DATES
            }
            registry = {
                symbol: {"name": name, "sector": sector}
                for symbol, name, sector in SYMBOLS
            }
            requested_symbols = [symbol for symbol, _, _ in SYMBOLS]
        bars_by_symbol = {
            symbol: fetch_bars(symbol, args.start, args.end, args.cache_dir, args.refresh)
            for symbol in requested_symbols
        }
    finally:
        bs.logout()

    bars_by_symbol = {symbol: bars for symbol, bars in bars_by_symbol.items() if len(bars) >= 300}
    specs = strategy_grid()
    simulations_by_spec: dict[str, dict[str, Simulation]] = {}
    summaries_by_spec: dict[str, dict[str, Any]] = {}
    train_start, train_end = date_range(2015, 2020)
    validation_start, validation_end = date_range(2021, 2023)
    test_start = dt.date(2024, 1, 1)
    test_end = dt.date.fromisoformat(args.end)
    train_symbols = cohorts[2015]
    validation_symbols = cohorts[2021]
    test_symbols = cohorts[2024]

    for spec in specs:
        simulations = {
            symbol: simulate(symbol, bars, spec) for symbol, bars in bars_by_symbol.items()
        }
        simulations_by_spec[spec.key] = simulations
        summaries_by_spec[spec.key] = {
            "family": spec.family,
            "params": spec.params,
            "train": summarize_period(
                simulations, bars_by_symbol, train_start, train_end, train_symbols
            ),
            "validation": summarize_period(
                simulations,
                bars_by_symbol,
                validation_start,
                validation_end,
                validation_symbols,
            ),
            "test": summarize_period(
                simulations, bars_by_symbol, test_start, test_end, test_symbols
            ),
            "operability": {
                "skipped_limit_up_entries": sum(
                    simulation.skipped_limit_up for simulation in simulations.values()
                ),
                "delayed_limit_down_exits": sum(
                    simulation.delayed_limit_down for simulation in simulations.values()
                ),
            },
        }

    selected: dict[str, dict[str, Any]] = {}
    family_specs: dict[str, list[StrategySpec]] = defaultdict(list)
    for spec in specs:
        family_specs[spec.family].append(spec)
    for family, candidates in family_specs.items():
        best = max(
            candidates,
            key=lambda item: selection_score(summaries_by_spec[item.key]["train"]),
        )
        candidate_tests = [summaries_by_spec[item.key]["test"] for item in candidates]
        selected[family] = {
            "selected_spec": best.key,
            "params": best.params,
            "selection_basis": "2015-2020 training score only",
            "train": summaries_by_spec[best.key]["train"],
            "validation": summaries_by_spec[best.key]["validation"],
            "test": summaries_by_spec[best.key]["test"],
            "operability": summaries_by_spec[best.key]["operability"],
            "parameter_stability": {
                "variants": len(candidates),
                "positive_test_mean_trade_variants": sum(
                    (item["mean_trade_return"] or 0) > 0 for item in candidate_tests
                ),
                "positive_test_median_cagr_variants": sum(
                    item["median_symbol_cagr"] > 0 for item in candidate_tests
                ),
                "test_mean_trade_return_range": [
                    min((item["mean_trade_return"] or 0) for item in candidate_tests),
                    max((item["mean_trade_return"] or 0) for item in candidate_tests),
                ],
            },
        }

    walk_forward: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for family, candidates in family_specs.items():
        for test_year in range(2021, test_end.year + 1):
            history_start = dt.date(max(2015, test_year - 5), 1, 1)
            history_end = dt.date(test_year - 1, 12, 31)
            best = max(
                candidates,
                key=lambda item: selection_score(
                    summarize_period(
                        simulations_by_spec[item.key],
                        bars_by_symbol,
                        history_start,
                        history_end,
                        cohorts[test_year],
                    )
                ),
            )
            year_end = test_end if test_year == test_end.year else dt.date(test_year, 12, 31)
            test_summary = summarize_period(
                simulations_by_spec[best.key],
                bars_by_symbol,
                dt.date(test_year, 1, 1),
                year_end,
                cohorts[test_year],
            )
            walk_forward[family].append(
                {
                    "train_start": history_start.isoformat(),
                    "train_end": history_end.isoformat(),
                    "test_year": test_year,
                    "selected_spec": best.key,
                    "test": test_summary,
                }
            )

    metadata = {
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "provider": "BaoStock",
        "provider_version": getattr(bs, "__version__", "unknown"),
        "adjustment": "front-adjusted (adjustflag=2)",
        "frequency": "daily",
        "requested_start": args.start,
        "requested_end": args.end,
        "execution": "signal at close; trade at next trading-day open",
        "cost_model": {
            "commission_each_side": BUY_COMMISSION,
            "transfer_fee_each_side": TRANSFER_FEE,
            "stamp_duty_sell_only": SELL_STAMP_DUTY,
            "slippage_each_side": SLIPPAGE,
        },
        "constraints": [
            "T+1 compatible exits",
            "skip entry when next open is at estimated up-limit",
            "delay exit when next open is at estimated down-limit",
            "no same-bar OHLC execution assumptions",
            "no future/pivot backfill functions",
        ],
        "sample_limitation": (
            "Point-in-time deterministic samples from the then-current CSI 300 and CSI 500 "
            "constituents reduce, but do not eliminate, index-selection and survivorship bias. "
            "Results are an engineering baseline, not proof of alpha."
            if args.universe_mode == "point-in-time"
            else "Current, hand-curated active stocks only; not point-in-time index membership, "
            "so survivorship bias remains. Results are an engineering baseline, not proof of alpha."
        ),
        "universe_mode": args.universe_mode,
        "cohort_per_index": args.cohort_per_index
        if args.universe_mode == "point-in-time"
        else None,
    }
    manifest = {
        symbol: {
            **registry[symbol],
            **data_manifest(bars),
        }
        for symbol, bars in bars_by_symbol.items()
    }
    return round_floats(
        {
            "metadata": metadata,
            "cohorts": {
                str(year): {
                    "snapshot": COHORT_DATES[year],
                    "symbols": sorted(set(bars_by_symbol) & symbols),
                }
                for year, symbols in cohorts.items()
            },
            "universe": manifest,
            "baselines": {
                "train": summarize_baseline(
                    bars_by_symbol, train_start, train_end, train_symbols
                ),
                "validation": summarize_baseline(
                    bars_by_symbol,
                    validation_start,
                    validation_end,
                    validation_symbols,
                ),
                "test": summarize_baseline(
                    bars_by_symbol, test_start, test_end, test_symbols
                ),
            },
            "selected": selected,
            "walk_forward": walk_forward,
            "all_variants": summaries_by_spec,
        }
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument("--start", default="2014-01-01")
    parser.add_argument("--end", default="2026-08-20")
    parser.add_argument(
        "--cache-dir", type=Path, default=Path("/tmp/hanai-kline-backtest-cache")
    )
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--refresh", action="store_true")
    parser.add_argument(
        "--universe-mode",
        choices=("point-in-time", "manual"),
        default="point-in-time",
    )
    parser.add_argument("--cohort-per-index", type=int, default=20)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    result = run(args)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"wrote {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
