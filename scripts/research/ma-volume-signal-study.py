#!/usr/bin/env python3
"""Second-round causal study for moving-average and volume signals.

The study consumes the point-in-time cohort manifest and the raw BaoStock cache
created by ``kline-signal-backtest.py``.  It does not download or redistribute
market data.  All decisions use only data available at the signal close and all
orders execute no earlier than the next open.

The candidate grid is intentionally declared in code before results are read.
It covers:

* deep-decline volume dry-up followed by an MA5 reclaim;
* low-volume pullbacks to MA20 in an MA20/MA60 uptrend;
* volume-confirmed MA20/MA60 reclaims;
* low-volume bases and quality high-volume breakouts;
* MA5/10/20/60 breakdowns and high-volume exhaustion warnings.

This is an auditable engineering experiment, not an assurance of future
profitability or investment advice.
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
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Callable, Iterable, Sequence


BUY_COMMISSION = 0.0003
SELL_COMMISSION = 0.0003
TRANSFER_FEE = 0.00001
SELL_STAMP_DUTY = 0.0005
SLIPPAGE = 0.001
HORIZONS = (5, 10, 20)
YEARS = (2021, 2022, 2023, 2024, 2025, 2026)


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
    params: dict[str, float | int | str | bool]

    @property
    def key(self) -> str:
        bits = ",".join(f"{key}={self.params[key]}" for key in sorted(self.params))
        return f"{self.family}[{bits}]"


@dataclasses.dataclass(frozen=True)
class SellSpec:
    family: str
    params: dict[str, float | int | str | bool]

    @property
    def key(self) -> str:
        bits = ",".join(f"{key}={self.params[key]}" for key in sorted(self.params))
        return f"{self.family}[{bits}]"


@dataclasses.dataclass
class Trade:
    symbol: str
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
    raw_buy_signal_count: int
    paired_exit_signal_count: int
    skipped_limit_up_entries: int
    delayed_limit_down_exits: int
    open_position_at_end: bool


@dataclasses.dataclass(frozen=True)
class EventOutcome:
    symbol: str
    decision_date: dt.date
    decision_index: int
    side: str
    horizon: int
    signed_return: float
    net_buy_return: float | None


def parse_number(raw: str) -> float | None:
    if raw == "":
        return None
    value = float(raw)
    return value if math.isfinite(value) else None


def load_bars(path: Path) -> list[Bar]:
    rows = json.loads(path.read_text(encoding="utf-8"))
    bars: list[Bar] = []
    for row in rows:
        if len(row) != 12:
            continue
        try:
            numeric = [parse_number(value) for value in row[2:8]]
        except ValueError:
            continue
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


def cache_path(cache_dir: Path, symbol: str, metadata: dict[str, Any]) -> Path:
    start = metadata["requested_start"]
    end = metadata["requested_end"]
    return cache_dir / f"{symbol.replace('.', '-')}-{start}-{end}-qfq.json"


def bar_manifest(bars: Sequence[Bar]) -> dict[str, Any]:
    digest = hashlib.sha256()
    for bar in bars:
        digest.update(
            (
                f"{bar.date.isoformat()}|{bar.open:.8f}|{bar.high:.8f}|"
                f"{bar.low:.8f}|{bar.close:.8f}|{bar.volume:.4f}\n"
            ).encode()
        )
    return {
        "rows": len(bars),
        "first_date": bars[0].date.isoformat() if bars else None,
        "last_date": bars[-1].date.isoformat() if bars else None,
        "sha256": digest.hexdigest(),
    }


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


def rolling_extreme(
    values: Sequence[float], period: int, operation: Callable[[Sequence[float]], float]
) -> list[float | None]:
    """Prior-period extreme excluding the current bar."""

    result: list[float | None] = [None] * len(values)
    for index in range(period, len(values)):
        result[index] = operation(values[index - period : index])
    return result


def indicators(bars: Sequence[Bar]) -> dict[str, list[float | None]]:
    closes = [bar.close for bar in bars]
    highs = [bar.high for bar in bars]
    lows = [bar.low for bar in bars]
    volumes = [bar.volume for bar in bars]
    result: dict[str, list[float | None]] = {}
    for period in (5, 10, 20, 60):
        result[f"ma{period}"] = sma(closes, period)
    for period in (5, 20, 60, 120):
        result[f"vol{period}"] = sma(volumes, period)
    for period in (20, 60):
        result[f"high{period}"] = rolling_extreme(highs, period, max)
        result[f"low{period}"] = rolling_extreme(lows, period, min)
    return result


def finite(*values: float | None) -> bool:
    return all(value is not None and math.isfinite(value) for value in values)


def ratio(left: float | None, right: float | None) -> float | None:
    if left is None or right is None or right <= 0:
        return None
    return left / right


def close_location(bar: Bar) -> float:
    width = bar.high - bar.low
    return (bar.close - bar.low) / width if width > 0 else 0.5


def prior_return(bars: Sequence[Bar], index: int, period: int) -> float | None:
    if index < period or bars[index - period].close <= 0:
        return None
    return bars[index].close / bars[index - period].close - 1


def recent_count(
    index: int, window: int, predicate: Callable[[int], bool], include_current: bool = False
) -> int:
    end = index + 1 if include_current else index
    start = max(0, end - window)
    return sum(predicate(position) for position in range(start, end))


def recent_any(index: int, window: int, predicate: Callable[[int], bool]) -> bool:
    return recent_count(index, window, predicate) > 0


EXIT_PROFILES: dict[str, dict[str, float | int | None]] = {
    "fast": {"stop": 0.08, "target": 0.18, "max_hold": 20},
    "balanced": {"stop": 0.10, "target": 0.25, "max_hold": 40},
    "trend": {"stop": 0.12, "target": None, "max_hold": 60},
}


def paired_specs() -> list[StrategySpec]:
    specs: list[StrategySpec] = []

    for dry_ratio in (0.50, 0.70):
        for drawdown in (0.15, 0.25):
            for trigger_volume in (0.80, 1.00):
                for exit_profile in ("fast", "balanced"):
                    specs.append(
                        StrategySpec(
                            "downtrend_dryup_reclaim",
                            {
                                "dry_ratio": dry_ratio,
                                "drawdown": drawdown,
                                "trigger_volume": trigger_volume,
                                "setup_window": 5,
                                "exit_profile": exit_profile,
                            },
                        )
                    )

    for dry_ratio in (0.60, 0.80):
        for trigger_volume in (0.80, 1.00):
            for confirmation in ("ma5", "previous_high"):
                for exit_profile in ("fast", "balanced"):
                    specs.append(
                        StrategySpec(
                            "trend_dryup_pullback",
                            {
                                "dry_ratio": dry_ratio,
                                "trigger_volume": trigger_volume,
                                "confirmation": confirmation,
                                "setup_window": 5,
                                "exit_profile": exit_profile,
                            },
                        )
                    )

    for period in (20, 60):
        for volume_ratio in (1.20, 1.50):
            for below_fraction in (0.50, 0.75):
                for exit_profile in ("balanced", "trend"):
                    specs.append(
                        StrategySpec(
                            "ma_reclaim_volume",
                            {
                                "period": period,
                                "volume_ratio": volume_ratio,
                                "below_fraction": below_fraction,
                                "lookback": 20,
                                "exit_profile": exit_profile,
                            },
                        )
                    )

    for dry_ratio in (0.60, 0.80):
        for base_width in (0.15, 0.25):
            for volume_ratio in (1.20, 1.50):
                specs.append(
                    StrategySpec(
                        "dry_base_breakout",
                        {
                            "dry_ratio": dry_ratio,
                            "base_width": base_width,
                            "volume_ratio": volume_ratio,
                            "exit_profile": "balanced",
                        },
                    )
                )

    for lookback in (20, 60):
        for volume_ratio in (1.50, 2.00):
            for minimum_close_location in (0.70, 0.85):
                specs.append(
                    StrategySpec(
                        "quality_volume_breakout",
                        {
                            "lookback": lookback,
                            "volume_ratio": volume_ratio,
                            "minimum_close_location": minimum_close_location,
                            "exit_profile": "balanced",
                        },
                    )
                )
    return specs


def sell_specs() -> list[SellSpec]:
    specs: list[SellSpec] = []
    for period in (5, 10, 20, 60):
        for volume_ratio in (0.0, 1.20, 1.50):
            for confirmation in (1, 2):
                specs.append(
                    SellSpec(
                        "ma_break",
                        {
                            "period": period,
                            "volume_ratio": volume_ratio,
                            "confirmation": confirmation,
                        },
                    )
                )
    for prior_gain in (0.15, 0.30):
        for volume_ratio in (2.0, 3.0):
            for maximum_close_location in (0.35, 0.50):
                for require_ma5_break in (False, True):
                    specs.append(
                        SellSpec(
                            "volume_climax_weakness",
                            {
                                "prior_gain": prior_gain,
                                "volume_ratio": volume_ratio,
                                "maximum_close_location": maximum_close_location,
                                "require_ma5_break": require_ma5_break,
                            },
                        )
                    )
    for prior_gain in (0.15, 0.30):
        for climax_volume_ratio in (2.0, 3.0):
            for maximum_close_location in (0.35, 0.50):
                for break_period in (5, 10):
                    for setup_window in (5, 10):
                        specs.append(
                            SellSpec(
                                "climax_then_ma_break",
                                {
                                    "prior_gain": prior_gain,
                                    "climax_volume_ratio": climax_volume_ratio,
                                    "maximum_close_location": maximum_close_location,
                                    "break_period": break_period,
                                    "setup_window": setup_window,
                                },
                            )
                        )
    return specs


def buy_flags(
    bars: Sequence[Bar], values: dict[str, list[float | None]], spec: StrategySpec
) -> list[bool]:
    flags = [False] * len(bars)
    p = spec.params
    for index in range(121, len(bars)):
        bar = bars[index]
        previous = bars[index - 1]
        ma5 = values["ma5"][index]
        ma10 = values["ma10"][index]
        ma20 = values["ma20"][index]
        ma60 = values["ma60"][index]
        vol5 = values["vol5"][index]
        vol20 = values["vol20"][index]
        vol60 = values["vol60"][index]
        high20 = values["high20"][index]
        low20 = values["low20"][index]
        high60 = values["high60"][index]
        if not finite(ma5, ma10, ma20, ma60, vol5, vol20, vol60, high20, low20, high60):
            continue
        assert ma5 is not None and ma10 is not None and ma20 is not None and ma60 is not None
        assert vol5 is not None and vol20 is not None and vol60 is not None
        assert high20 is not None and low20 is not None and high60 is not None
        daily_volume_ratio = bar.volume / vol20 if vol20 > 0 else 0.0
        volume_ma_ratio = vol5 / vol60 if vol60 > 0 else math.inf

        if spec.family == "downtrend_dryup_reclaim":
            setup_window = int(p["setup_window"])
            dry_ratio = float(p["dry_ratio"])
            drawdown = float(p["drawdown"])

            def is_setup(position: int) -> bool:
                setup_vol5 = values["vol5"][position]
                setup_vol60 = values["vol60"][position]
                setup_ma20 = values["ma20"][position]
                setup_high60 = values["high60"][position]
                if not finite(setup_vol5, setup_vol60, setup_ma20, setup_high60):
                    return False
                assert setup_vol5 is not None and setup_vol60 is not None
                assert setup_ma20 is not None and setup_high60 is not None
                return (
                    setup_vol60 > 0
                    and setup_high60 > 0
                    and setup_vol5 / setup_vol60 <= dry_ratio
                    and bars[position].close <= setup_ma20
                    and bars[position].close / setup_high60 - 1 <= -drawdown
                )

            previous_ma5 = values["ma5"][index - 1]
            flags[index] = (
                recent_any(index, setup_window, is_setup)
                and previous_ma5 is not None
                and previous.close <= previous_ma5
                and bar.close > ma5
                and bar.close > bar.open
                and close_location(bar) >= 0.60
                and daily_volume_ratio >= float(p["trigger_volume"])
                and daily_volume_ratio <= 2.50
            )

        elif spec.family == "trend_dryup_pullback":
            setup_window = int(p["setup_window"])
            dry_ratio = float(p["dry_ratio"])

            def is_setup(position: int) -> bool:
                setup_vol5 = values["vol5"][position]
                setup_vol60 = values["vol60"][position]
                setup_ma20 = values["ma20"][position]
                setup_ma60 = values["ma60"][position]
                if not finite(setup_vol5, setup_vol60, setup_ma20, setup_ma60):
                    return False
                assert setup_vol5 is not None and setup_vol60 is not None
                assert setup_ma20 is not None and setup_ma60 is not None
                return (
                    setup_vol60 > 0
                    and setup_vol5 / setup_vol60 <= dry_ratio
                    and setup_ma20 > setup_ma60
                    and bars[position].low <= setup_ma20 * 1.02
                    and bars[position].close >= setup_ma20 * 0.97
                )

            confirmation = str(p["confirmation"])
            confirmation_ok = bar.close > ma5
            if confirmation == "previous_high":
                confirmation_ok = confirmation_ok and bar.close > previous.high
            flags[index] = (
                ma20 > ma60
                and ma60 >= float(values["ma60"][index - 5] or ma60) * 0.99
                and recent_any(index, setup_window, is_setup)
                and confirmation_ok
                and bar.close > previous.close
                and close_location(bar) >= 0.60
                and daily_volume_ratio >= float(p["trigger_volume"])
                and daily_volume_ratio <= 2.50
            )

        elif spec.family == "ma_reclaim_volume":
            period = int(p["period"])
            moving_average = values[f"ma{period}"][index]
            previous_average = values[f"ma{period}"][index - 1]
            if moving_average is None or previous_average is None:
                continue
            lookback = int(p["lookback"])
            below = recent_count(
                index,
                lookback,
                lambda position: (
                    values[f"ma{period}"][position] is not None
                    and bars[position].close < float(values[f"ma{period}"][position])
                ),
            )
            flags[index] = (
                previous.close <= previous_average
                and bar.close > moving_average
                and below / lookback >= float(p["below_fraction"])
                and daily_volume_ratio >= float(p["volume_ratio"])
                and close_location(bar) >= 0.65
                and bar.close > bar.open
            )

        elif spec.family == "dry_base_breakout":
            base_width = high20 / low20 - 1 if low20 > 0 else math.inf
            flags[index] = (
                volume_ma_ratio <= float(p["dry_ratio"])
                and base_width <= float(p["base_width"])
                and bar.close > high20
                and bar.close >= ma20
                and ma20 >= ma60 * 0.98
                and bar.close / ma20 <= 1.20
                and daily_volume_ratio >= float(p["volume_ratio"])
                and close_location(bar) >= 0.70
            )

        elif spec.family == "quality_volume_breakout":
            lookback = int(p["lookback"])
            prior_high = values[f"high{lookback}"][index]
            if prior_high is None:
                continue
            flags[index] = (
                bar.close > prior_high
                and ma20 > ma60
                and bar.close / ma20 <= 1.30
                and daily_volume_ratio >= float(p["volume_ratio"])
                and close_location(bar) >= float(p["minimum_close_location"])
            )
        else:  # pragma: no cover - fixed candidate grid
            raise ValueError(spec.family)
    return flags


def universal_exit_flags(
    bars: Sequence[Bar], values: dict[str, list[float | None]], profile: str
) -> tuple[list[bool], list[str | None]]:
    flags = [False] * len(bars)
    reasons: list[str | None] = [None] * len(bars)
    for index in range(61, len(bars)):
        bar = bars[index]
        ma5 = values["ma5"][index]
        ma10 = values["ma10"][index]
        ma20 = values["ma20"][index]
        ma60 = values["ma60"][index]
        vol20 = values["vol20"][index]
        if not finite(ma5, ma10, ma20, ma60, vol20):
            continue
        assert ma5 is not None and ma10 is not None and ma20 is not None and ma60 is not None
        assert vol20 is not None
        previous_ma5 = values["ma5"][index - 1]
        previous_ma10 = values["ma10"][index - 1]
        volume_ratio = bar.volume / vol20 if vol20 > 0 else 0.0
        gain20 = prior_return(bars, index, 20)
        climax = (
            gain20 is not None
            and gain20 >= 0.20
            and volume_ratio >= 2.50
            and close_location(bar) <= 0.45
        )
        ma_cross_down = (
            previous_ma5 is not None
            and previous_ma10 is not None
            and previous_ma5 >= previous_ma10
            and ma5 < ma10
        )
        if climax:
            flags[index] = True
            reasons[index] = "volume_climax_weakness"
        elif profile == "fast" and (bar.close < ma10 or ma_cross_down):
            flags[index] = True
            reasons[index] = "ma10_or_ma5_cross_break"
        elif profile == "balanced" and (
            ma_cross_down
            or (
                bar.close < ma20
                and bars[index - 1].close < float(values["ma20"][index - 1] or ma20)
            )
        ):
            flags[index] = True
            reasons[index] = "ma20_two_close_or_ma5_cross_break"
        elif profile == "trend" and (bar.close < ma20 or ma20 < ma60):
            flags[index] = True
            reasons[index] = "ma20_or_ma60_trend_break"
    return flags, reasons


def sell_flags(
    bars: Sequence[Bar], values: dict[str, list[float | None]], spec: SellSpec
) -> list[bool]:
    flags = [False] * len(bars)
    p = spec.params
    for index in range(121, len(bars)):
        bar = bars[index]
        vol20 = values["vol20"][index]
        if vol20 is None or vol20 <= 0:
            continue
        volume_ratio = bar.volume / vol20
        if spec.family == "ma_break":
            period = int(p["period"])
            ma = values[f"ma{period}"][index]
            previous_ma = values[f"ma{period}"][index - 1]
            if ma is None or previous_ma is None:
                continue
            confirmation = int(p["confirmation"])
            if confirmation == 1:
                broke = bars[index - 1].close >= previous_ma and bar.close < ma
            else:
                earlier_ma = values[f"ma{period}"][index - 2]
                broke = (
                    earlier_ma is not None
                    and bars[index - 2].close >= earlier_ma
                    and bars[index - 1].close < previous_ma
                    and bar.close < ma
                )
            flags[index] = broke and volume_ratio >= float(p["volume_ratio"])
        elif spec.family == "volume_climax_weakness":
            gain = prior_return(bars, index, 20)
            ma5 = values["ma5"][index]
            previous_ma5 = values["ma5"][index - 1]
            if gain is None or ma5 is None or previous_ma5 is None:
                continue
            ma5_break = bars[index - 1].close >= previous_ma5 and bar.close < ma5
            flags[index] = (
                gain >= float(p["prior_gain"])
                and volume_ratio >= float(p["volume_ratio"])
                and close_location(bar) <= float(p["maximum_close_location"])
                and (not bool(p["require_ma5_break"]) or ma5_break)
            )
        elif spec.family == "climax_then_ma_break":
            break_period = int(p["break_period"])
            moving_average = values[f"ma{break_period}"][index]
            previous_average = values[f"ma{break_period}"][index - 1]
            if moving_average is None or previous_average is None:
                continue

            def is_climax(position: int) -> bool:
                setup_vol20 = values["vol20"][position]
                gain = prior_return(bars, position, 20)
                return (
                    setup_vol20 is not None
                    and setup_vol20 > 0
                    and gain is not None
                    and gain >= float(p["prior_gain"])
                    and bars[position].volume / setup_vol20
                    >= float(p["climax_volume_ratio"])
                    and close_location(bars[position])
                    <= float(p["maximum_close_location"])
                )

            flags[index] = (
                recent_any(index, int(p["setup_window"]), is_climax)
                and bars[index - 1].close >= previous_average
                and bar.close < moving_average
            )
        else:  # pragma: no cover - fixed candidate grid
            raise ValueError(spec.family)
    return flags


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
    band = limit_ratio(bar)
    tolerance = max(0.01, bar.preclose * 0.0005)
    if side == "buy":
        return bar.open >= bar.preclose * (1 + band) - tolerance
    return bar.open <= bar.preclose * (1 - band) + tolerance


def execution_prices(
    raw_price: float, side: str, friction_multiplier: float
) -> float:
    commission = (
        BUY_COMMISSION if side == "buy" else SELL_COMMISSION + SELL_STAMP_DUTY
    )
    fee = (commission + TRANSFER_FEE) * friction_multiplier
    slippage = SLIPPAGE * friction_multiplier
    if side == "buy":
        return raw_price * (1 + slippage) / (1 - fee)
    return raw_price * (1 - slippage) * (1 - fee)


def simulate(
    symbol: str,
    bars: Sequence[Bar],
    values: dict[str, list[float | None]],
    spec: StrategySpec,
    friction_multiplier: float = 1.0,
    precomputed_exit: tuple[list[bool], list[str | None]] | None = None,
) -> Simulation:
    entries = buy_flags(bars, values, spec)
    profile_name = str(spec.params["exit_profile"])
    profile = EXIT_PROFILES[profile_name]
    exits, exit_reasons = precomputed_exit or universal_exit_flags(
        bars, values, profile_name
    )
    trades: list[Trade] = []
    paired_exit_signal_count = 0
    skipped_limit_up = 0
    delayed_limit_down = 0
    cash = 1.0
    shares = 0.0
    entry_signal_index: int | None = None
    entry_index: int | None = None
    entry_raw_price: float | None = None
    entry_effective_price: float | None = None
    pending_entry_signal: int | None = None
    pending_exit: tuple[int, str] | None = None

    for index, bar in enumerate(bars):
        if pending_exit is not None and shares > 0 and entry_index is not None:
            if unavailable_at_limit(bar, "sell"):
                delayed_limit_down += 1
            else:
                signal_index, reason = pending_exit
                exit_effective = execution_prices(
                    bar.open, "sell", friction_multiplier
                )
                cash = shares * exit_effective
                assert entry_signal_index is not None
                assert entry_raw_price is not None
                assert entry_effective_price is not None
                trades.append(
                    Trade(
                        symbol=symbol,
                        spec_key=spec.key,
                        entry_signal_date=bars[entry_signal_index].date,
                        entry_date=bars[entry_index].date,
                        entry_index=entry_index,
                        entry_price=entry_raw_price,
                        exit_signal_date=bars[signal_index].date,
                        exit_date=bar.date,
                        exit_index=index,
                        exit_price=bar.open,
                        hold_days=index - entry_index,
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
                entry_index = index
                entry_raw_price = bar.open
                entry_effective_price = execution_prices(
                    bar.open, "buy", friction_multiplier
                )
                shares = cash / entry_effective_price
                cash = 0.0
            pending_entry_signal = None

        if shares > 0 and entry_index is not None and pending_exit is None:
            assert entry_raw_price is not None
            raw_return = bar.close / entry_raw_price - 1
            reason: str | None = None
            if index > entry_index and raw_return <= -float(profile["stop"] or 0):
                reason = "close_stop"
            elif index > entry_index and exits[index]:
                reason = exit_reasons[index] or "rule"
            elif (
                index > entry_index
                and profile["target"] is not None
                and raw_return >= float(profile["target"])
            ):
                reason = "close_profit_target"
            elif index - entry_index >= int(profile["max_hold"] or 0):
                reason = "max_hold"
            if reason is not None:
                paired_exit_signal_count += 1
                pending_exit = (index, reason)
        elif shares == 0 and index + 1 < len(bars) and entries[index]:
            pending_entry_signal = index

    if shares > 0 and entry_index is not None and len(bars) - 1 > entry_index:
        last = bars[-1]
        exit_effective = execution_prices(
            last.close, "sell", friction_multiplier
        )
        cash = shares * exit_effective
        assert entry_signal_index is not None
        assert entry_raw_price is not None
        assert entry_effective_price is not None
        trades.append(
            Trade(
                symbol=symbol,
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
    return Simulation(
        trades=trades,
        raw_buy_signal_count=sum(entries),
        paired_exit_signal_count=paired_exit_signal_count,
        skipped_limit_up_entries=skipped_limit_up,
        delayed_limit_down_exits=delayed_limit_down,
        open_position_at_end=shares > 0,
    )


def median(values: Sequence[float]) -> float:
    return statistics.median(values) if values else 0.0


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


def max_drawdown(
    points: Iterable[tuple[dt.date, float]], start: dt.date, end: dt.date
) -> float:
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


def closed_trade_path_metrics(
    trades: Sequence[Trade], start: dt.date, end: dt.date
) -> tuple[float, float, float]:
    """Return total return, annualized return and drawdown for closed trades.

    The fixed train/validation/test summaries intentionally reset equity to one
    at each period boundary and include only trades whose entry belongs to that
    period.  This avoids a position opened before the boundary leaking into the
    following period's score.  Drawdown is measured on the closed-trade equity
    path and therefore understates intratrade drawdown; that limitation is
    recorded in the output metadata.
    """

    equity = 1.0
    peak = 1.0
    drawdown = 0.0
    selected = sorted(
        (trade for trade in trades if start <= trade.entry_date <= end),
        key=lambda trade: (trade.exit_date, trade.entry_date),
    )
    for trade in selected:
        equity *= max(0.0, 1 + trade.net_return)
        peak = max(peak, equity)
        if peak > 0:
            drawdown = max(drawdown, 1 - equity / peak)
    years = max((end - start).days / 365.25, 1 / 365.25)
    cagr = equity ** (1 / years) - 1 if equity > 0 else -1.0
    return equity - 1, cagr, drawdown


def cluster_bootstrap_trades(
    trades: Sequence[Trade], iterations: int = 2000
) -> dict[str, list[float] | None]:
    grouped: dict[str, list[Trade]] = defaultdict(list)
    for trade in trades:
        grouped[trade.symbol].append(trade)
    symbols = sorted(grouped)
    if not symbols:
        return {"win_rate_95ci": None, "mean_return_95ci": None}
    rng = random.Random(20260822)
    win_rates: list[float] = []
    means: list[float] = []
    for _ in range(iterations):
        sampled: list[Trade] = []
        for _ in symbols:
            sampled.extend(grouped[rng.choice(symbols)])
        if sampled:
            returns = [trade.net_return for trade in sampled]
            win_rates.append(sum(value > 0 for value in returns) / len(returns))
            means.append(statistics.fmean(returns))
    return {
        "win_rate_95ci": percentile_interval(win_rates),
        "mean_return_95ci": percentile_interval(means),
    }


def percentile_interval(values: Sequence[float]) -> list[float] | None:
    if not values:
        return None
    ordered = sorted(values)
    return [
        ordered[int(0.025 * (len(ordered) - 1))],
        ordered[int(0.975 * (len(ordered) - 1))],
    ]


def summarize_trades(
    simulations: dict[str, Simulation],
    start: dt.date,
    end: dt.date,
    symbols: set[str],
    bootstrap: bool = False,
) -> dict[str, Any]:
    selected_symbols = set(simulations) & symbols
    trades = [
        trade
        for symbol, simulation in simulations.items()
        if symbol in selected_symbols
        for trade in simulation.trades
        if start <= trade.entry_date <= end
    ]
    returns = [trade.net_return for trade in trades]
    total_returns: list[float] = []
    cagrs: list[float] = []
    drawdowns: list[float] = []
    for symbol in selected_symbols:
        total, cagr, drawdown = closed_trade_path_metrics(
            simulations[symbol].trades, start, end
        )
        total_returns.append(total)
        cagrs.append(cagr)
        drawdowns.append(drawdown)
    gross_profit = sum(value for value in returns if value > 0)
    gross_loss = -sum(value for value in returns if value < 0)
    trades_per_symbol = Counter(trade.symbol for trade in trades)
    positive_return_per_symbol: dict[str, float] = defaultdict(float)
    for trade in trades:
        if trade.net_return > 0:
            positive_return_per_symbol[trade.symbol] += trade.net_return
    reason_counts = Counter(trade.exit_reason for trade in trades)
    ordered = sorted(returns, reverse=True)
    trimmed_count = max(1, math.ceil(len(ordered) * 0.05)) if ordered else 0
    without_top_5pct = ordered[trimmed_count:] if trimmed_count else []
    result: dict[str, Any] = {
        "start": start.isoformat(),
        "end": end.isoformat(),
        "symbols": len(selected_symbols),
        "trades": len(trades),
        "win_rate": sum(value > 0 for value in returns) / len(returns) if returns else None,
        "mean_trade_return": statistics.fmean(returns) if returns else None,
        "median_trade_return": median(returns) if returns else None,
        "profit_factor": gross_profit / gross_loss if gross_loss > 0 else None,
        "mean_hold_days": statistics.fmean(trade.hold_days for trade in trades)
        if trades
        else None,
        "median_symbol_total_return": median(total_returns),
        "median_symbol_cagr": median(cagrs),
        "median_symbol_closed_trade_max_drawdown": median(drawdowns),
        "mean_return_without_top_5pct": statistics.fmean(without_top_5pct)
        if without_top_5pct
        else None,
        "largest_symbol_trade_share": max(trades_per_symbol.values()) / len(trades)
        if trades
        else None,
        "largest_symbol_gross_profit_share": max(positive_return_per_symbol.values())
        / gross_profit
        if gross_profit > 0
        else None,
        "exit_reasons": dict(sorted(reason_counts.items())),
        "skipped_limit_up_entries": sum(
            simulations[symbol].skipped_limit_up_entries for symbol in selected_symbols
        ),
        "delayed_limit_down_exits": sum(
            simulations[symbol].delayed_limit_down_exits for symbol in selected_symbols
        ),
        "open_positions_at_data_end": sum(
            simulations[symbol].open_position_at_end for symbol in selected_symbols
        ),
    }
    if bootstrap:
        result["cluster_bootstrap"] = cluster_bootstrap_trades(trades)
    return result


def event_outcomes(
    flags_by_symbol: dict[str, list[bool]],
    bars_by_symbol: dict[str, list[Bar]],
    side: str,
    start: dt.date,
    end: dt.date,
    symbols: set[str],
    horizon: int,
    cooldown: bool = False,
) -> list[EventOutcome]:
    outcomes: list[EventOutcome] = []
    for symbol in sorted(set(flags_by_symbol) & symbols):
        bars = bars_by_symbol[symbol]
        flags = flags_by_symbol[symbol]
        last_kept = -10_000
        for decision_index, active in enumerate(flags):
            if not active or not (start <= bars[decision_index].date <= end):
                continue
            if cooldown and decision_index - last_kept <= horizon:
                continue
            entry_index = decision_index + 1
            target_index = entry_index + horizon
            if target_index >= len(bars):
                continue
            if side == "buy" and unavailable_at_limit(bars[entry_index], "buy"):
                continue
            raw_return = bars[target_index].close / bars[entry_index].open - 1
            signed = raw_return if side == "buy" else -raw_return
            net_buy: float | None = None
            if side == "buy":
                entry_effective = execution_prices(bars[entry_index].open, "buy", 1.0)
                exit_effective = execution_prices(
                    bars[target_index].close, "sell", 1.0
                )
                net_buy = exit_effective / entry_effective - 1
            outcomes.append(
                EventOutcome(
                    symbol=symbol,
                    decision_date=bars[decision_index].date,
                    decision_index=decision_index,
                    side=side,
                    horizon=horizon,
                    signed_return=signed,
                    net_buy_return=net_buy,
                )
            )
            if cooldown:
                last_kept = decision_index
    return outcomes


def cluster_bootstrap_events(
    outcomes: Sequence[EventOutcome], iterations: int = 2000
) -> dict[str, list[float] | None]:
    grouped: dict[str, list[EventOutcome]] = defaultdict(list)
    for outcome in outcomes:
        grouped[outcome.symbol].append(outcome)
    symbols = sorted(grouped)
    if not symbols:
        return {"direction_rate_95ci": None, "mean_signed_return_95ci": None}
    rng = random.Random(20260823)
    rates: list[float] = []
    means: list[float] = []
    for _ in range(iterations):
        sampled: list[EventOutcome] = []
        for _ in symbols:
            sampled.extend(grouped[rng.choice(symbols)])
        if sampled:
            signed = [item.signed_return for item in sampled]
            rates.append(sum(value > 0 for value in signed) / len(signed))
            means.append(statistics.fmean(signed))
    return {
        "direction_rate_95ci": percentile_interval(rates),
        "mean_signed_return_95ci": percentile_interval(means),
    }


def summarize_events(
    flags_by_symbol: dict[str, list[bool]],
    bars_by_symbol: dict[str, list[Bar]],
    side: str,
    start: dt.date,
    end: dt.date,
    symbols: set[str],
    horizon: int,
    bootstrap: bool = False,
) -> dict[str, Any]:
    raw = event_outcomes(
        flags_by_symbol, bars_by_symbol, side, start, end, symbols, horizon
    )
    cooldown = event_outcomes(
        flags_by_symbol,
        bars_by_symbol,
        side,
        start,
        end,
        symbols,
        horizon,
        cooldown=True,
    )

    def metrics(outcomes: Sequence[EventOutcome]) -> dict[str, Any]:
        signed = [item.signed_return for item in outcomes]
        net_buy = [
            item.net_buy_return
            for item in outcomes
            if item.net_buy_return is not None
        ]
        result: dict[str, Any] = {
            "signals": len(outcomes),
            "symbols": len({item.symbol for item in outcomes}),
            "direction_correct_rate": sum(value > 0 for value in signed) / len(signed)
            if signed
            else None,
            "mean_signed_return": statistics.fmean(signed) if signed else None,
            "median_signed_return": median(signed),
            "net_buy_positive_rate": sum(value > 0 for value in net_buy) / len(net_buy)
            if net_buy
            else None,
            "mean_net_buy_return": statistics.fmean(net_buy) if net_buy else None,
        }
        if bootstrap:
            result["cluster_bootstrap"] = cluster_bootstrap_events(outcomes)
        return result

    return {"raw": metrics(raw), "non_overlapping_cooldown": metrics(cooldown)}


def trade_selection_score(summary: dict[str, Any], minimum_trades: int = 60) -> float:
    """Training-only score that rewards return quality and penalizes drawdown."""

    trades = int(summary["trades"])
    if trades < minimum_trades:
        return -100.0 + trades / 10_000
    mean_return = float(summary["mean_trade_return"] or -1)
    trimmed_return = float(summary["mean_return_without_top_5pct"] or -1)
    cagr = float(summary["median_symbol_cagr"])
    drawdown = float(summary["median_symbol_closed_trade_max_drawdown"])
    profit_factor = float(summary["profit_factor"] or 0)
    return (
        cagr
        - 0.35 * drawdown
        + 0.25 * mean_return
        + 0.25 * trimmed_return
        + 0.02 * min(profit_factor, 3)
    )


def event_selection_score(
    summary: dict[str, Any], minimum_signals: int = 60
) -> float:
    """Training-only score for independent directional sell events."""

    metrics = summary["non_overlapping_cooldown"]
    signals = int(metrics["signals"])
    if signals < minimum_signals:
        return -100.0 + signals / 10_000
    direction_rate = float(metrics["direction_correct_rate"] or 0)
    mean_signed = float(metrics["mean_signed_return"] or -1)
    return direction_rate - 0.5 + 4 * mean_signed


def date_range(start_year: int, end_year: int) -> tuple[dt.date, dt.date]:
    return dt.date(start_year, 1, 1), dt.date(end_year, 12, 31)


def round_floats(value: Any) -> Any:
    if isinstance(value, float):
        return round(value, 8) if math.isfinite(value) else None
    if isinstance(value, dict):
        return {key: round_floats(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [round_floats(item) for item in value]
    return value


def market_regime(
    bars_by_symbol: dict[str, list[Bar]],
    symbols: set[str],
    start: dt.date,
    end: dt.date,
) -> dict[str, Any]:
    returns: list[float] = []
    for symbol in sorted(set(bars_by_symbol) & symbols):
        selected = [bar for bar in bars_by_symbol[symbol] if start <= bar.date <= end]
        if len(selected) < 2 or selected[0].open <= 0:
            continue
        returns.append(selected[-1].close / selected[0].open - 1)
    middle = median(returns)
    label = "sideways"
    if middle >= 0.10:
        label = "rising"
    elif middle <= -0.10:
        label = "falling"
    return {
        "classification_is_ex_post_diagnostic_only": True,
        "symbols": len(returns),
        "median_buy_hold_return": middle if returns else None,
        "positive_symbol_rate": sum(value > 0 for value in returns) / len(returns)
        if returns
        else None,
        "regime": label if returns else "unavailable",
    }


def aggregate_trade_walk_forward(entries: Sequence[dict[str, Any]]) -> dict[str, Any]:
    tests = [entry["test"] for entry in entries]
    total_trades = sum(int(item["trades"]) for item in tests)

    def weighted(field: str) -> float | None:
        available = [
            (float(item[field]), int(item["trades"]))
            for item in tests
            if item[field] is not None and int(item["trades"]) > 0
        ]
        denominator = sum(weight for _, weight in available)
        return (
            sum(value * weight for value, weight in available) / denominator
            if denominator
            else None
        )

    return {
        "years": len(entries),
        "trades": total_trades,
        "weighted_win_rate": weighted("win_rate"),
        "weighted_mean_trade_return": weighted("mean_trade_return"),
        "positive_mean_return_years": sum(
            (item["mean_trade_return"] or 0) > 0 for item in tests
        ),
        "positive_median_cagr_years": sum(
            item["median_symbol_cagr"] > 0 for item in tests
        ),
    }


def aggregate_event_walk_forward(entries: Sequence[dict[str, Any]]) -> dict[str, Any]:
    metrics = [entry["test"]["non_overlapping_cooldown"] for entry in entries]
    total = sum(int(item["signals"]) for item in metrics)

    def weighted(field: str) -> float | None:
        available = [
            (float(item[field]), int(item["signals"]))
            for item in metrics
            if item[field] is not None and int(item["signals"]) > 0
        ]
        denominator = sum(weight for _, weight in available)
        return (
            sum(value * weight for value, weight in available) / denominator
            if denominator
            else None
        )

    return {
        "years": len(entries),
        "signals": total,
        "weighted_direction_correct_rate": weighted("direction_correct_rate"),
        "weighted_mean_signed_return": weighted("mean_signed_return"),
        "positive_mean_signed_return_years": sum(
            (item["mean_signed_return"] or 0) > 0 for item in metrics
        ),
        "direction_rate_above_50pct_years": sum(
            (item["direction_correct_rate"] or 0) > 0.5 for item in metrics
        ),
    }


def trade_release_gates(
    test: dict[str, Any],
    double_friction: dict[str, Any],
    walk_forward: dict[str, Any],
) -> dict[str, Any]:
    bootstrap = test.get("cluster_bootstrap", {})
    win_ci = bootstrap.get("win_rate_95ci")
    mean_ci = bootstrap.get("mean_return_95ci")
    gates = {
        "at_least_100_completed_test_trades": int(test["trades"]) >= 100,
        "test_win_rate_at_least_52pct": (test["win_rate"] or 0) >= 0.52,
        "test_win_rate_ci_lower_at_least_45pct": bool(win_ci)
        and float(win_ci[0]) >= 0.45,
        "test_mean_net_return_positive": (test["mean_trade_return"] or 0) > 0,
        "test_mean_return_ci_lower_positive": bool(mean_ci)
        and float(mean_ci[0]) > 0,
        "test_profit_factor_at_least_1_20": (test["profit_factor"] or 0) >= 1.20,
        "positive_after_removing_top_5pct_trades": (
            test["mean_return_without_top_5pct"] or 0
        )
        > 0,
        "positive_under_double_friction": (
            double_friction["mean_trade_return"] or 0
        )
        > 0,
        "walk_forward_positive_in_at_least_4_of_6_years": int(
            walk_forward["positive_mean_return_years"]
        )
        >= 4,
        "test_median_symbol_cagr_positive": test["median_symbol_cagr"] > 0,
    }
    return {
        "definition": (
            "Historical research release gate only. Passing would not guarantee "
            "future profitability or a user's realized success rate."
        ),
        "gates": gates,
        "passed": all(gates.values()),
        "passed_count": sum(gates.values()),
        "total_count": len(gates),
    }


def event_release_gates(
    test: dict[str, Any], walk_forward: dict[str, Any]
) -> dict[str, Any]:
    metrics = test["non_overlapping_cooldown"]
    bootstrap = metrics.get("cluster_bootstrap", {})
    direction_ci = bootstrap.get("direction_rate_95ci")
    mean_ci = bootstrap.get("mean_signed_return_95ci")
    gates = {
        "at_least_100_non_overlapping_test_signals": int(metrics["signals"]) >= 100,
        "test_direction_correct_rate_at_least_55pct": (
            metrics["direction_correct_rate"] or 0
        )
        >= 0.55,
        "test_direction_ci_lower_above_50pct": bool(direction_ci)
        and float(direction_ci[0]) > 0.50,
        "test_mean_signed_return_positive": (metrics["mean_signed_return"] or 0) > 0,
        "test_mean_signed_return_ci_lower_positive": bool(mean_ci)
        and float(mean_ci[0]) > 0,
        "walk_forward_positive_in_at_least_4_of_6_years": int(
            walk_forward["positive_mean_signed_return_years"]
        )
        >= 4,
        "walk_forward_direction_above_50pct_in_at_least_4_of_6_years": int(
            walk_forward["direction_rate_above_50pct_years"]
        )
        >= 4,
    }
    return {
        "definition": (
            "Directional warning research gate only; it does not model an investor's "
            "cost basis and is not a guaranteed sell outcome."
        ),
        "gates": gates,
        "passed": all(gates.values()),
        "passed_count": sum(gates.values()),
        "total_count": len(gates),
    }


def buy_family_stability(
    candidates: Sequence[StrategySpec], summaries: dict[str, dict[str, Any]]
) -> dict[str, Any]:
    validation = [summaries[spec.key]["validation"] for spec in candidates]
    tests = [summaries[spec.key]["test"] for spec in candidates]
    return {
        "variants": len(candidates),
        "positive_validation_mean_variants": sum(
            (item["mean_trade_return"] or 0) > 0 for item in validation
        ),
        "validation_profit_factor_above_one_variants": sum(
            (item["profit_factor"] or 0) > 1 for item in validation
        ),
        "positive_test_mean_variants_descriptive_only": sum(
            (item["mean_trade_return"] or 0) > 0 for item in tests
        ),
        "positive_test_median_cagr_variants_descriptive_only": sum(
            item["median_symbol_cagr"] > 0 for item in tests
        ),
        "test_mean_return_range_descriptive_only": [
            min(float(item["mean_trade_return"] or 0) for item in tests),
            max(float(item["mean_trade_return"] or 0) for item in tests),
        ],
    }


def sell_family_stability(
    candidates: Sequence[SellSpec], summaries: dict[str, dict[str, Any]]
) -> dict[str, Any]:
    validation = [
        summaries[spec.key]["validation"]["non_overlapping_cooldown"]
        for spec in candidates
    ]
    tests = [
        summaries[spec.key]["test"]["non_overlapping_cooldown"]
        for spec in candidates
    ]
    return {
        "variants": len(candidates),
        "validation_direction_above_50pct_variants": sum(
            (item["direction_correct_rate"] or 0) > 0.5 for item in validation
        ),
        "positive_validation_mean_variants": sum(
            (item["mean_signed_return"] or 0) > 0 for item in validation
        ),
        "test_direction_above_50pct_variants_descriptive_only": sum(
            (item["direction_correct_rate"] or 0) > 0.5 for item in tests
        ),
        "positive_test_mean_variants_descriptive_only": sum(
            (item["mean_signed_return"] or 0) > 0 for item in tests
        ),
        "test_direction_rate_range_descriptive_only": [
            min(float(item["direction_correct_rate"] or 0) for item in tests),
            max(float(item["direction_correct_rate"] or 0) for item in tests),
        ],
    }


def run(args: argparse.Namespace) -> dict[str, Any]:
    baseline = json.loads(args.baseline.read_text(encoding="utf-8"))
    baseline_metadata = baseline["metadata"]
    requested_end = dt.date.fromisoformat(baseline_metadata["requested_end"])
    cohorts = {
        int(year): set(payload["symbols"])
        for year, payload in baseline["cohorts"].items()
    }

    bars_by_symbol: dict[str, list[Bar]] = {}
    manifest_mismatches: list[dict[str, Any]] = []
    missing_cache: list[str] = []
    for symbol, expected in sorted(baseline["universe"].items()):
        path = cache_path(args.cache_dir, symbol, baseline_metadata)
        if not path.exists():
            missing_cache.append(symbol)
            continue
        bars = load_bars(path)
        if len(bars) < 300:
            continue
        actual = bar_manifest(bars)
        expected_core = {
            key: expected.get(key)
            for key in ("rows", "first_date", "last_date", "sha256")
        }
        if actual != expected_core:
            manifest_mismatches.append(
                {"symbol": symbol, "expected": expected_core, "actual": actual}
            )
            continue
        bars_by_symbol[symbol] = bars
    if missing_cache:
        raise RuntimeError(
            f"missing {len(missing_cache)} cache files; first={missing_cache[:5]}"
        )
    if manifest_mismatches:
        raise RuntimeError(
            f"manifest mismatch for {len(manifest_mismatches)} symbols; "
            f"first={manifest_mismatches[0]}"
        )

    values_by_symbol = {
        symbol: indicators(bars) for symbol, bars in bars_by_symbol.items()
    }
    exit_cache = {
        (symbol, profile): universal_exit_flags(
            bars_by_symbol[symbol], values_by_symbol[symbol], profile
        )
        for symbol in bars_by_symbol
        for profile in EXIT_PROFILES
    }

    train_start, train_end = date_range(2015, 2020)
    validation_start, validation_end = date_range(2021, 2023)
    test_start = dt.date(2024, 1, 1)
    test_end = requested_end
    split_definitions = {
        "train": (train_start, train_end, cohorts[2015]),
        "validation": (validation_start, validation_end, cohorts[2021]),
        "test": (test_start, test_end, cohorts[2024]),
    }

    def simulations_for(
        spec: StrategySpec,
        friction_multiplier: float = 1.0,
        symbols: set[str] | None = None,
    ) -> dict[str, Simulation]:
        targets = sorted(set(bars_by_symbol) & (symbols or set(bars_by_symbol)))
        return {
            symbol: simulate(
                symbol,
                bars_by_symbol[symbol],
                values_by_symbol[symbol],
                spec,
                friction_multiplier,
                exit_cache[(symbol, str(spec.params["exit_profile"]))],
            )
            for symbol in targets
        }

    buy_candidates = paired_specs()
    buy_summaries: dict[str, dict[str, Any]] = {}
    buy_history: dict[str, dict[int, dict[str, Any]]] = defaultdict(dict)
    buy_yearly: dict[str, dict[int, dict[str, Any]]] = defaultdict(dict)
    for number, spec in enumerate(buy_candidates, 1):
        simulations = simulations_for(spec)
        fixed = {
            name: summarize_trades(simulations, start, end, symbols)
            for name, (start, end, symbols) in split_definitions.items()
        }
        buy_summaries[spec.key] = {
            "family": spec.family,
            "params": spec.params,
            **fixed,
        }
        for year in YEARS:
            history_start = dt.date(max(2015, year - 5), 1, 1)
            history_end = dt.date(year - 1, 12, 31)
            year_end = requested_end if year == requested_end.year else dt.date(year, 12, 31)
            cohort = cohorts[year]
            buy_history[spec.key][year] = summarize_trades(
                simulations, history_start, history_end, cohort
            )
            buy_yearly[spec.key][year] = summarize_trades(
                simulations, dt.date(year, 1, 1), year_end, cohort
            )
        if number % 8 == 0 or number == len(buy_candidates):
            print(
                f"buy candidates {number}/{len(buy_candidates)}",
                file=sys.stderr,
                flush=True,
            )

    buy_by_family: dict[str, list[StrategySpec]] = defaultdict(list)
    for spec in buy_candidates:
        buy_by_family[spec.family].append(spec)
    buy_family_selection: dict[str, dict[str, Any]] = {}
    buy_family_winners: list[StrategySpec] = []
    for family, candidates in sorted(buy_by_family.items()):
        winner = max(
            candidates,
            key=lambda item: trade_selection_score(
                buy_summaries[item.key]["train"]
            ),
        )
        buy_family_winners.append(winner)
        buy_family_selection[family] = {
            "selected_spec": winner.key,
            "selection_basis": "best 2015-2020 training score within family",
            "training_score": trade_selection_score(
                buy_summaries[winner.key]["train"]
            ),
            "train": buy_summaries[winner.key]["train"],
            "validation": buy_summaries[winner.key]["validation"],
            "test_descriptive_after_selection": buy_summaries[winner.key]["test"],
            "parameter_stability": buy_family_stability(
                candidates, buy_summaries
            ),
        }
    final_buy_spec = max(
        buy_family_winners,
        key=lambda item: trade_selection_score(
            buy_summaries[item.key]["validation"], minimum_trades=30
        ),
    )
    final_buy_simulations = simulations_for(final_buy_spec)
    final_buy_fixed = {
        name: summarize_trades(
            final_buy_simulations,
            start,
            end,
            symbols,
            bootstrap=name in {"validation", "test"},
        )
        for name, (start, end, symbols) in split_definitions.items()
    }
    final_buy_flags = {
        symbol: buy_flags(
            bars_by_symbol[symbol], values_by_symbol[symbol], final_buy_spec
        )
        for symbol in bars_by_symbol
    }
    buy_event_study: dict[str, Any] = {}
    for split, (start, end, symbols) in split_definitions.items():
        buy_event_study[split] = {
            str(horizon): summarize_events(
                final_buy_flags,
                bars_by_symbol,
                "buy",
                start,
                end,
                symbols,
                horizon,
                bootstrap=split == "test" and horizon == 20,
            )
            for horizon in HORIZONS
        }
    double_friction_simulations = simulations_for(
        final_buy_spec, friction_multiplier=2.0, symbols=cohorts[2024]
    )
    double_friction_test = summarize_trades(
        double_friction_simulations, test_start, test_end, cohorts[2024]
    )

    buy_walk_forward: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for family, candidates in sorted(buy_by_family.items()):
        for year in YEARS:
            winner = max(
                candidates,
                key=lambda item: trade_selection_score(
                    buy_history[item.key][year], minimum_trades=30
                ),
            )
            buy_walk_forward[family].append(
                {
                    "history_start": dt.date(max(2015, year - 5), 1, 1).isoformat(),
                    "history_end": dt.date(year - 1, 12, 31).isoformat(),
                    "evaluation_year": year,
                    "selected_spec": winner.key,
                    "test": buy_yearly[winner.key][year],
                }
            )
    final_buy_walk_aggregate = aggregate_trade_walk_forward(
        buy_walk_forward[final_buy_spec.family]
    )
    final_buy_annual = [
        {
            "year": year,
            "strategy": buy_yearly[final_buy_spec.key][year],
            "market": market_regime(
                bars_by_symbol,
                cohorts[year],
                dt.date(year, 1, 1),
                requested_end if year == requested_end.year else dt.date(year, 12, 31),
            ),
        }
        for year in YEARS
    ]
    buy_gates = trade_release_gates(
        final_buy_fixed["test"],
        double_friction_test,
        final_buy_walk_aggregate,
    )

    sell_candidates = sell_specs()
    sell_summaries: dict[str, dict[str, Any]] = {}
    sell_history: dict[str, dict[int, dict[str, Any]]] = defaultdict(dict)
    sell_yearly: dict[str, dict[int, dict[str, Any]]] = defaultdict(dict)
    for number, spec in enumerate(sell_candidates, 1):
        flags = {
            symbol: sell_flags(
                bars_by_symbol[symbol], values_by_symbol[symbol], spec
            )
            for symbol in bars_by_symbol
        }
        fixed = {
            name: summarize_events(
                flags, bars_by_symbol, "sell", start, end, symbols, 20
            )
            for name, (start, end, symbols) in split_definitions.items()
        }
        sell_summaries[spec.key] = {
            "family": spec.family,
            "params": spec.params,
            **fixed,
        }
        for year in YEARS:
            history_start = dt.date(max(2015, year - 5), 1, 1)
            history_end = dt.date(year - 1, 12, 31)
            year_end = requested_end if year == requested_end.year else dt.date(year, 12, 31)
            cohort = cohorts[year]
            sell_history[spec.key][year] = summarize_events(
                flags,
                bars_by_symbol,
                "sell",
                history_start,
                history_end,
                cohort,
                20,
            )
            sell_yearly[spec.key][year] = summarize_events(
                flags,
                bars_by_symbol,
                "sell",
                dt.date(year, 1, 1),
                year_end,
                cohort,
                20,
            )
        if number % 8 == 0 or number == len(sell_candidates):
            print(
                f"sell candidates {number}/{len(sell_candidates)}",
                file=sys.stderr,
                flush=True,
            )

    sell_by_family: dict[str, list[SellSpec]] = defaultdict(list)
    for spec in sell_candidates:
        sell_by_family[spec.family].append(spec)
    sell_family_selection: dict[str, dict[str, Any]] = {}
    sell_family_winners: list[SellSpec] = []
    for family, candidates in sorted(sell_by_family.items()):
        winner = max(
            candidates,
            key=lambda item: event_selection_score(
                sell_summaries[item.key]["train"]
            ),
        )
        sell_family_winners.append(winner)
        sell_family_selection[family] = {
            "selected_spec": winner.key,
            "selection_basis": "best 2015-2020 training score within family",
            "training_score": event_selection_score(
                sell_summaries[winner.key]["train"]
            ),
            "train": sell_summaries[winner.key]["train"],
            "validation": sell_summaries[winner.key]["validation"],
            "test_descriptive_after_selection": sell_summaries[winner.key]["test"],
            "parameter_stability": sell_family_stability(
                candidates, sell_summaries
            ),
        }
    final_sell_spec = max(
        sell_family_winners,
        key=lambda item: event_selection_score(
            sell_summaries[item.key]["validation"], minimum_signals=30
        ),
    )
    final_sell_flags = {
        symbol: sell_flags(
            bars_by_symbol[symbol], values_by_symbol[symbol], final_sell_spec
        )
        for symbol in bars_by_symbol
    }
    final_sell_fixed = {
        name: summarize_events(
            final_sell_flags,
            bars_by_symbol,
            "sell",
            start,
            end,
            symbols,
            20,
            bootstrap=name in {"validation", "test"},
        )
        for name, (start, end, symbols) in split_definitions.items()
    }
    sell_event_study: dict[str, Any] = {}
    for split, (start, end, symbols) in split_definitions.items():
        sell_event_study[split] = {
            str(horizon): summarize_events(
                final_sell_flags,
                bars_by_symbol,
                "sell",
                start,
                end,
                symbols,
                horizon,
                bootstrap=split == "test" and horizon == 20,
            )
            for horizon in HORIZONS
        }

    sell_walk_forward: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for family, candidates in sorted(sell_by_family.items()):
        for year in YEARS:
            winner = max(
                candidates,
                key=lambda item: event_selection_score(
                    sell_history[item.key][year], minimum_signals=30
                ),
            )
            sell_walk_forward[family].append(
                {
                    "history_start": dt.date(max(2015, year - 5), 1, 1).isoformat(),
                    "history_end": dt.date(year - 1, 12, 31).isoformat(),
                    "evaluation_year": year,
                    "selected_spec": winner.key,
                    "test": sell_yearly[winner.key][year],
                }
            )
    final_sell_walk_aggregate = aggregate_event_walk_forward(
        sell_walk_forward[final_sell_spec.family]
    )
    final_sell_annual = [
        {
            "year": year,
            "strategy": sell_yearly[final_sell_spec.key][year],
            "market": market_regime(
                bars_by_symbol,
                cohorts[year],
                dt.date(year, 1, 1),
                requested_end if year == requested_end.year else dt.date(year, 12, 31),
            ),
        }
        for year in YEARS
    ]
    sell_gates = event_release_gates(
        final_sell_fixed["test"], final_sell_walk_aggregate
    )

    script_hash = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    result = {
        "metadata": {
            "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
            "purpose": "causal moving-average and volume strategy study",
            "script_sha256": script_hash,
            "source_artifact": str(args.baseline),
            "source_artifact_sha256": hashlib.sha256(
                args.baseline.read_bytes()
            ).hexdigest(),
            "provider": baseline_metadata["provider"],
            "adjustment": baseline_metadata["adjustment"],
            "frequency": "daily",
            "requested_start": baseline_metadata["requested_start"],
            "requested_end": baseline_metadata["requested_end"],
            "execution": "signal at close; execute at next trading-day open",
            "candidate_grid_frozen_before_execution": True,
            "candidate_counts": {
                "paired_buy": len(buy_candidates),
                "directional_sell": len(sell_candidates),
            },
            "selection_protocol": [
                "select parameters within each family using 2015-2020 training only",
                "select the final family using 2021-2023 validation only",
                "inspect 2024-2026-08-20 test only after both selections are fixed",
                "annual walk-forward selects parameters from the previous five years",
            ],
            "cost_model": baseline_metadata["cost_model"],
            "constraints": baseline_metadata["constraints"],
            "drawdown_note": (
                "Period equity resets at one and uses only trades entered in that period. "
                "Drawdown is measured on closed-trade equity and understates intratrade drawdown."
            ),
            "limitations": [
                "Passing a historical gate cannot guarantee future success.",
                "Point-in-time index cohorts reduce but do not eliminate selection and survivorship bias.",
                "Daily OHLCV cannot prove intraday path or queue position.",
                "Sell event accuracy is directional and does not include an investor-specific cost basis.",
                "Market regime labels use full-year returns and are diagnostic, never trading inputs.",
            ],
        },
        "source_validation": {
            "symbols": len(bars_by_symbol),
            "rows": sum(len(bars) for bars in bars_by_symbol.values()),
            "manifest_mismatches": manifest_mismatches,
            "missing_cache": missing_cache,
        },
        "fixed_splits": {
            name: {
                "start": start.isoformat(),
                "end": end.isoformat(),
                "cohort": 2015 if name == "train" else 2021 if name == "validation" else 2024,
                "symbols": len(set(bars_by_symbol) & symbols),
            }
            for name, (start, end, symbols) in split_definitions.items()
        },
        "paired_buy_study": {
            "family_selection": buy_family_selection,
            "final_selection": {
                "selected_spec": final_buy_spec.key,
                "selected_family": final_buy_spec.family,
                "params": final_buy_spec.params,
                "selection_basis": (
                    "family parameters selected on training; final family selected on validation"
                ),
                **final_buy_fixed,
                "double_friction_test": double_friction_test,
                "fixed_spec_annual_diagnostic": final_buy_annual,
                "release_gates": buy_gates,
            },
            "selected_event_study": buy_event_study,
            "walk_forward": {
                "by_family": buy_walk_forward,
                "selected_family_aggregate": final_buy_walk_aggregate,
            },
            "all_variants": buy_summaries,
        },
        "directional_sell_study": {
            "family_selection": sell_family_selection,
            "final_selection": {
                "selected_spec": final_sell_spec.key,
                "selected_family": final_sell_spec.family,
                "params": final_sell_spec.params,
                "selection_basis": (
                    "family parameters selected on training; final family selected on validation"
                ),
                **final_sell_fixed,
                "fixed_spec_annual_diagnostic": final_sell_annual,
                "release_gates": sell_gates,
            },
            "selected_event_study": sell_event_study,
            "walk_forward": {
                "by_family": sell_walk_forward,
                "selected_family_aggregate": final_sell_walk_aggregate,
            },
            "all_variants": sell_summaries,
        },
    }
    return round_floats(result)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--baseline",
        type=Path,
        default=Path("docs/research-data/kline-signal-backtest-2026-08-21.json"),
    )
    parser.add_argument(
        "--cache-dir", type=Path, default=Path("/tmp/hanai-kline-backtest-cache")
    )
    parser.add_argument("--output", type=Path, required=True)
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
