#!/usr/bin/env python3
"""Causal event study for MA5/10 and MA20/60 turning-point markers.

The markers in this study are observations, not buy/sell instructions.  Every
event is known only after the signal bar closes.  Outcomes start at the next
open and use point-in-time index cohorts plus a deliberately adverse historical
constituent sample.  Same-date controls match the pre-event price/MA state while
omitting the defining volume condition.

The event definitions are frozen in this file before results are evaluated:

* quiet_pullback: rising MA ribbon, price back inside the ribbon, meaningful
  retreat from a recent high, and broad/current volume contraction;
* volume_reacceleration: a recent quiet pullback followed by a strong, high-
  volume close through the prior high and above the fast MA;
* post_rise_huge_volume: an established rise followed by >=2.5x VMA20 volume;
* post_rise_huge_volume_strong / weak: split the huge-volume event by where the
  bar closes in its range, because volume alone has no directional meaning.

This is an auditable engineering experiment, not investment advice and not a
guarantee that historical conditional frequencies persist.
"""

from __future__ import annotations

import argparse
import dataclasses
import datetime as dt
import hashlib
import importlib.util
import json
import math
import random
import statistics
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any, Iterable, Sequence


BASE_PATH = Path(__file__).with_name("ma-volume-signal-study.py")
BASE_SPEC = importlib.util.spec_from_file_location("ma_volume_signal_base", BASE_PATH)
if BASE_SPEC is None or BASE_SPEC.loader is None:  # pragma: no cover
    raise RuntimeError(f"cannot import {BASE_PATH}")
base = importlib.util.module_from_spec(BASE_SPEC)
sys.modules[BASE_SPEC.name] = base
BASE_SPEC.loader.exec_module(base)


HORIZONS = (5, 10, 20)
BOOTSTRAP_ITERATIONS = 2_000
CONTROL_COUNT = 3


@dataclasses.dataclass(frozen=True)
class PairConfig:
    key: str
    label: str
    fast: int
    slow: int
    slope_lookback: int
    pullback_lookback: int
    pullback_depth: float
    setup_window: int
    primary_horizon: int
    barrier: float
    prior_rise_lookback: int
    prior_rise_minimum: float


PAIR_CONFIGS = (
    PairConfig(
        key="ma5_ma10",
        label="短线 MA5 / MA10",
        fast=5,
        slow=10,
        slope_lookback=3,
        pullback_lookback=10,
        pullback_depth=0.03,
        setup_window=5,
        primary_horizon=10,
        barrier=0.03,
        prior_rise_lookback=20,
        prior_rise_minimum=0.15,
    ),
    PairConfig(
        key="ma20_ma60",
        label="中线 MA20 / MA60",
        fast=20,
        slow=60,
        slope_lookback=5,
        pullback_lookback=20,
        pullback_depth=0.05,
        setup_window=10,
        primary_horizon=20,
        barrier=0.05,
        prior_rise_lookback=60,
        prior_rise_minimum=0.25,
    ),
)


EVENT_META: dict[str, dict[str, str | None]] = {
    "quiet_pullback": {
        "label": "缩量回踩均线带",
        "side": "up",
        "product_semantics": "观察",
    },
    "volume_reacceleration": {
        "label": "回踩后放量转强",
        "side": "up",
        "product_semantics": "转强确认",
    },
    "post_rise_huge_volume": {
        "label": "上涨后巨量",
        "side": None,
        "product_semantics": "分歧放大",
    },
    "post_rise_huge_volume_strong": {
        "label": "上涨后巨量强收盘",
        "side": "up",
        "product_semantics": "强势换手",
    },
    "post_rise_huge_volume_weak": {
        "label": "上涨后巨量弱收盘",
        "side": "down",
        "product_semantics": "衰竭风险",
    },
}


@dataclasses.dataclass(frozen=True)
class FeaturePoint:
    prior_return: float
    distance_fast: float
    ribbon_spread: float
    volatility20: float


@dataclasses.dataclass(frozen=True)
class Outcome:
    symbol: str
    decision_date: dt.date
    decision_index: int
    horizon: int
    raw_return: float
    maximum_up: float
    maximum_down: float
    upper_hit_day: int | None
    lower_hit_day: int | None


@dataclasses.dataclass(frozen=True)
class MatchedObservation:
    symbol: str
    event_signed_return: float | None
    control_signed_return: float | None
    event_direction: float | None
    control_direction: float | None
    event_barrier_success: float | None
    control_barrier_success: float | None
    event_change_hit: float
    control_change_hit: float
    event_raw_return: float
    control_raw_return: float
    event_abs_return: float
    control_abs_return: float


@dataclasses.dataclass(frozen=True)
class Context:
    key: str
    label: str
    start: dt.date
    end: dt.date
    fixed_symbols: frozenset[str] | None
    annual_symbols: dict[int, frozenset[str]] | None

    def symbols_on(self, date: dt.date) -> frozenset[str]:
        if self.fixed_symbols is not None:
            return self.fixed_symbols
        assert self.annual_symbols is not None
        return self.annual_symbols.get(date.year, frozenset())

    @property
    def all_symbols(self) -> set[str]:
        if self.fixed_symbols is not None:
            return set(self.fixed_symbols)
        assert self.annual_symbols is not None
        result: set[str] = set()
        for symbols in self.annual_symbols.values():
            result.update(symbols)
        return result


def rolling_volatility(bars: Sequence[Any], period: int = 20) -> list[float | None]:
    returns: list[float | None] = [None]
    for index in range(1, len(bars)):
        prior = bars[index - 1].close
        returns.append(bars[index].close / prior - 1 if prior > 0 else None)
    result: list[float | None] = [None] * len(bars)
    for index in range(period, len(bars)):
        window = [value for value in returns[index - period + 1 : index + 1] if value is not None]
        if len(window) == period:
            result[index] = statistics.pstdev(window)
    return result


def recent_high(bars: Sequence[Any], index: int, lookback: int) -> float | None:
    if index < lookback:
        return None
    return max(bar.high for bar in bars[index - lookback : index])


def recent_event(flags: Sequence[bool], index: int, window: int) -> bool:
    start = max(0, index - window)
    return any(flags[start:index])


def build_pair_state(
    bars: Sequence[Any], values: dict[str, list[float | None]], pair: PairConfig
) -> dict[str, Any]:
    length = len(bars)
    events = {key: [False] * length for key in EVENT_META}
    eligibility = {key: [False] * length for key in EVENT_META}
    features: list[FeaturePoint | None] = [None] * length
    volatilities = rolling_volatility(bars)

    fast_values = values[f"ma{pair.fast}"]
    slow_values = values[f"ma{pair.slow}"]
    for index in range(121, length):
        fast = fast_values[index]
        slow = slow_values[index]
        old_slow = slow_values[index - pair.slope_lookback]
        vol5 = values["vol5"][index]
        vol20 = values["vol20"][index]
        volatility20 = volatilities[index]
        prior_peak = recent_high(bars, index, pair.pullback_lookback)
        prior_rise = base.prior_return(bars, index - 1, pair.prior_rise_lookback)
        if not base.finite(fast, slow, old_slow, vol5, vol20, volatility20):
            continue
        assert fast is not None and slow is not None and old_slow is not None
        assert vol5 is not None and vol20 is not None and volatility20 is not None
        if min(fast, slow, vol20) <= 0:
            continue

        bar = bars[index]
        current_volume_ratio = bar.volume / vol20
        broad_volume_ratio = vol5 / vol20
        uptrend = fast > slow and slow > old_slow
        drawdown = bar.close / prior_peak - 1 if prior_peak and prior_peak > 0 else None
        pullback_base = (
            uptrend
            and drawdown is not None
            and drawdown <= -pair.pullback_depth
            and bar.low <= fast * 1.01
            and bar.close >= slow * 0.98
            and bar.close <= fast * 1.02
        )
        quiet_pullback = (
            pullback_base
            and current_volume_ratio <= 0.70
            and broad_volume_ratio <= 0.85
        )
        eligibility["quiet_pullback"][index] = pullback_base
        events["quiet_pullback"][index] = quiet_pullback

        prior_quiet = recent_event(
            events["quiet_pullback"], index, pair.setup_window
        )
        reacceleration_base = (
            uptrend
            and prior_quiet
            and bar.close > bars[index - 1].high
            and bar.close > fast
            and bar.close > bar.open
            and base.close_location(bar) >= 0.65
        )
        eligibility["volume_reacceleration"][index] = reacceleration_base
        events["volume_reacceleration"][index] = (
            reacceleration_base and 1.50 <= current_volume_ratio <= 3.50
        )

        post_rise_base = (
            uptrend
            and prior_rise is not None
            and prior_rise >= pair.prior_rise_minimum
            and bars[index - 1].close > float(fast_values[index - 1] or 0)
        )
        huge_volume = post_rise_base and current_volume_ratio >= 2.50
        strong_close = bar.close > bar.open and base.close_location(bar) >= 0.70
        weak_close = base.close_location(bar) <= 0.35
        eligibility["post_rise_huge_volume"][index] = post_rise_base
        eligibility["post_rise_huge_volume_strong"][index] = (
            post_rise_base and strong_close
        )
        eligibility["post_rise_huge_volume_weak"][index] = (
            post_rise_base and weak_close
        )
        events["post_rise_huge_volume"][index] = huge_volume
        events["post_rise_huge_volume_strong"][index] = (
            huge_volume and strong_close
        )
        events["post_rise_huge_volume_weak"][index] = huge_volume and weak_close

        prior_return = base.prior_return(bars, index, pair.prior_rise_lookback)
        if prior_return is not None:
            features[index] = FeaturePoint(
                prior_return=prior_return,
                distance_fast=bar.close / fast - 1,
                ribbon_spread=fast / slow - 1,
                volatility20=volatility20,
            )
    return {
        "events": events,
        "eligibility": eligibility,
        "features": features,
    }


def event_outcome(
    symbol: str,
    bars: Sequence[Any],
    decision_index: int,
    horizon: int,
    barrier: float,
) -> Outcome | None:
    entry_index = decision_index + 1
    target_index = decision_index + horizon
    if entry_index >= len(bars) or target_index >= len(bars):
        return None
    entry = bars[entry_index].open
    if entry <= 0:
        return None
    upper_hit_day: int | None = None
    lower_hit_day: int | None = None
    maximum_up = -math.inf
    maximum_down = math.inf
    for index in range(entry_index, target_index + 1):
        day = index - decision_index
        up = bars[index].high / entry - 1
        down = bars[index].low / entry - 1
        maximum_up = max(maximum_up, up)
        maximum_down = min(maximum_down, down)
        if upper_hit_day is None and up >= barrier:
            upper_hit_day = day
        if lower_hit_day is None and down <= -barrier:
            lower_hit_day = day
    return Outcome(
        symbol=symbol,
        decision_date=bars[decision_index].date,
        decision_index=decision_index,
        horizon=horizon,
        raw_return=bars[target_index].close / entry - 1,
        maximum_up=maximum_up,
        maximum_down=maximum_down,
        upper_hit_day=upper_hit_day,
        lower_hit_day=lower_hit_day,
    )


def barrier_result(outcome: Outcome, side: str | None) -> float | None:
    if side is None:
        return None
    favorable = outcome.upper_hit_day if side == "up" else outcome.lower_hit_day
    adverse = outcome.lower_hit_day if side == "up" else outcome.upper_hit_day
    if favorable is None and adverse is None:
        return None
    if favorable is not None and adverse is None:
        return 1.0
    if favorable is None and adverse is not None:
        return 0.0
    assert favorable is not None and adverse is not None
    if favorable == adverse:
        return None
    return 1.0 if favorable < adverse else 0.0


def change_hit(outcome: Outcome) -> float:
    return float(outcome.upper_hit_day is not None or outcome.lower_hit_day is not None)


def signed_return(outcome: Outcome, side: str | None) -> float | None:
    if side is None:
        return None
    return outcome.raw_return if side == "up" else -outcome.raw_return


def percentile_interval(values: Sequence[float]) -> list[float] | None:
    if not values:
        return None
    ordered = sorted(values)
    return [
        ordered[int(0.025 * (len(ordered) - 1))],
        ordered[int(0.975 * (len(ordered) - 1))],
    ]


def cluster_bootstrap_outcomes(
    outcomes: Sequence[Outcome], side: str | None
) -> dict[str, list[float] | None]:
    grouped: dict[str, list[Outcome]] = defaultdict(list)
    for outcome in outcomes:
        grouped[outcome.symbol].append(outcome)
    symbols = sorted(grouped)
    if not symbols:
        return {
            "positive_terminal_rate_95ci": None,
            "direction_rate_95ci": None,
            "mean_return_95ci": None,
            "mean_absolute_return_95ci": None,
            "barrier_success_95ci": None,
            "change_hit_rate_95ci": None,
        }
    rng = random.Random(20260824)
    direction_rates: list[float] = []
    positive_rates: list[float] = []
    mean_returns: list[float] = []
    mean_absolute_returns: list[float] = []
    barrier_rates: list[float] = []
    change_rates: list[float] = []
    for _ in range(BOOTSTRAP_ITERATIONS):
        sampled: list[Outcome] = []
        for _symbol in symbols:
            sampled.extend(grouped[rng.choice(symbols)])
        returns = [item.raw_return for item in sampled]
        positive_rates.append(sum(value > 0 for value in returns) / len(returns))
        change_rates.append(statistics.fmean(change_hit(item) for item in sampled))
        if side is None:
            mean_returns.append(statistics.fmean(returns))
            mean_absolute_returns.append(
                statistics.fmean(abs(value) for value in returns)
            )
            continue
        signed = [value if side == "up" else -value for value in returns]
        direction_rates.append(sum(value > 0 for value in signed) / len(signed))
        mean_returns.append(statistics.fmean(signed))
        resolved = [barrier_result(item, side) for item in sampled]
        resolved = [value for value in resolved if value is not None]
        if resolved:
            barrier_rates.append(statistics.fmean(resolved))
    return {
        "positive_terminal_rate_95ci": percentile_interval(positive_rates),
        "direction_rate_95ci": percentile_interval(direction_rates),
        "mean_return_95ci": percentile_interval(mean_returns),
        "mean_absolute_return_95ci": percentile_interval(mean_absolute_returns),
        "barrier_success_95ci": percentile_interval(barrier_rates),
        "change_hit_rate_95ci": percentile_interval(change_rates),
    }


def summarize_outcomes(
    outcomes: Sequence[Outcome], side: str | None, bootstrap: bool = False
) -> dict[str, Any]:
    raw_returns = [item.raw_return for item in outcomes]
    result: dict[str, Any] = {
        "events": len(outcomes),
        "symbols": len({item.symbol for item in outcomes}),
        "positive_terminal_rate": (
            sum(value > 0 for value in raw_returns) / len(raw_returns)
            if raw_returns
            else None
        ),
        "mean_terminal_return": (
            statistics.fmean(raw_returns) if raw_returns else None
        ),
        "median_terminal_return": (
            statistics.median(raw_returns) if raw_returns else None
        ),
        "mean_absolute_terminal_return": (
            statistics.fmean(abs(value) for value in raw_returns)
            if raw_returns
            else None
        ),
        "change_hit_rate": (
            statistics.fmean(change_hit(item) for item in outcomes)
            if outcomes
            else None
        ),
        "mean_maximum_up": (
            statistics.fmean(item.maximum_up for item in outcomes)
            if outcomes
            else None
        ),
        "mean_maximum_down": (
            statistics.fmean(item.maximum_down for item in outcomes)
            if outcomes
            else None
        ),
    }
    if side is not None:
        signed = [value if side == "up" else -value for value in raw_returns]
        resolved = [barrier_result(item, side) for item in outcomes]
        resolved_values = [value for value in resolved if value is not None]
        result.update(
            {
                "expected_direction": side,
                "direction_correct_rate": (
                    sum(value > 0 for value in signed) / len(signed)
                    if signed
                    else None
                ),
                "mean_signed_return": (
                    statistics.fmean(signed) if signed else None
                ),
                "barrier_resolved_events": len(resolved_values),
                "barrier_success_rate_among_resolved": (
                    statistics.fmean(resolved_values)
                    if resolved_values
                    else None
                ),
                "barrier_success_rate_all_events": (
                    sum(value == 1.0 for value in resolved) / len(resolved)
                    if resolved
                    else None
                ),
                "barrier_failure_rate_all_events": (
                    sum(value == 0.0 for value in resolved) / len(resolved)
                    if resolved
                    else None
                ),
                "barrier_unresolved_or_ambiguous_rate": (
                    sum(value is None for value in resolved) / len(resolved)
                    if resolved
                    else None
                ),
            }
        )
    if bootstrap:
        result["cluster_bootstrap"] = cluster_bootstrap_outcomes(outcomes, side)
    return result


def feature_distance(left: FeaturePoint, right: FeaturePoint) -> float:
    return (
        abs(left.prior_return - right.prior_return) / 0.10
        + abs(left.distance_fast - right.distance_fast) / 0.03
        + abs(left.ribbon_spread - right.ribbon_spread) / 0.03
        + abs(left.volatility20 - right.volatility20) / 0.02
    )


def cluster_bootstrap_matched(
    observations: Sequence[MatchedObservation], side: str | None
) -> dict[str, list[float] | None]:
    grouped: dict[str, list[MatchedObservation]] = defaultdict(list)
    for observation in observations:
        grouped[observation.symbol].append(observation)
    symbols = sorted(grouped)
    if not symbols:
        return {
            "direction_lift_95ci": None,
            "mean_return_lift_95ci": None,
            "positive_rate_lift_95ci": None,
            "barrier_success_lift_95ci": None,
            "change_hit_lift_95ci": None,
        }
    rng = random.Random(20260825)
    direction_lifts: list[float] = []
    return_lifts: list[float] = []
    positive_lifts: list[float] = []
    barrier_lifts: list[float] = []
    change_lifts: list[float] = []
    for _ in range(BOOTSTRAP_ITERATIONS):
        sampled: list[MatchedObservation] = []
        for _symbol in symbols:
            sampled.extend(grouped[rng.choice(symbols)])
        change_lifts.append(
            statistics.fmean(
                item.event_change_hit - item.control_change_hit for item in sampled
            )
        )
        if side is None:
            return_lifts.append(
                statistics.fmean(
                    item.event_raw_return - item.control_raw_return
                    for item in sampled
                )
            )
            positive_lifts.append(
                statistics.fmean(
                    float(item.event_raw_return > 0)
                    - float(item.control_raw_return > 0)
                    for item in sampled
                )
            )
            continue
        directional = [
            item
            for item in sampled
            if item.event_direction is not None and item.control_direction is not None
        ]
        if directional:
            direction_lifts.append(
                statistics.fmean(
                    float(item.event_direction) - float(item.control_direction)
                    for item in directional
                )
            )
            return_lifts.append(
                statistics.fmean(
                    float(item.event_signed_return)
                    - float(item.control_signed_return)
                    for item in directional
                )
            )
        barriers = [
            item
            for item in sampled
            if item.event_barrier_success is not None
            and item.control_barrier_success is not None
        ]
        if barriers:
            barrier_lifts.append(
                statistics.fmean(
                    float(item.event_barrier_success)
                    - float(item.control_barrier_success)
                    for item in barriers
                )
            )
    return {
        "direction_lift_95ci": percentile_interval(direction_lifts),
        "mean_return_lift_95ci": percentile_interval(return_lifts),
        "positive_rate_lift_95ci": percentile_interval(positive_lifts),
        "barrier_success_lift_95ci": percentile_interval(barrier_lifts),
        "change_hit_lift_95ci": percentile_interval(change_lifts),
    }


def summarize_matched(
    observations: Sequence[MatchedObservation], side: str | None
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "matched_events": len(observations),
        "event_change_hit_rate": (
            statistics.fmean(item.event_change_hit for item in observations)
            if observations
            else None
        ),
        "control_change_hit_rate": (
            statistics.fmean(item.control_change_hit for item in observations)
            if observations
            else None
        ),
        "change_hit_lift": (
            statistics.fmean(
                item.event_change_hit - item.control_change_hit
                for item in observations
            )
            if observations
            else None
        ),
    }
    if side is None:
        result.update(
            {
                "event_positive_terminal_rate": (
                    statistics.fmean(
                        float(item.event_raw_return > 0) for item in observations
                    )
                    if observations
                    else None
                ),
                "control_positive_terminal_rate": (
                    statistics.fmean(
                        float(item.control_raw_return > 0) for item in observations
                    )
                    if observations
                    else None
                ),
                "positive_terminal_rate_lift": (
                    statistics.fmean(
                        float(item.event_raw_return > 0)
                        - float(item.control_raw_return > 0)
                        for item in observations
                    )
                    if observations
                    else None
                ),
                "event_mean_terminal_return": (
                    statistics.fmean(item.event_raw_return for item in observations)
                    if observations
                    else None
                ),
                "control_mean_terminal_return": (
                    statistics.fmean(item.control_raw_return for item in observations)
                    if observations
                    else None
                ),
                "mean_terminal_return_lift": (
                    statistics.fmean(
                        item.event_raw_return - item.control_raw_return
                        for item in observations
                    )
                    if observations
                    else None
                ),
                "event_mean_absolute_terminal_return": (
                    statistics.fmean(item.event_abs_return for item in observations)
                    if observations
                    else None
                ),
                "control_mean_absolute_terminal_return": (
                    statistics.fmean(item.control_abs_return for item in observations)
                    if observations
                    else None
                ),
                "absolute_return_lift": (
                    statistics.fmean(
                        item.event_abs_return - item.control_abs_return
                        for item in observations
                    )
                    if observations
                    else None
                ),
            }
        )
    else:
        directional = [
            item
            for item in observations
            if item.event_direction is not None and item.control_direction is not None
        ]
        barriers = [
            item
            for item in observations
            if item.event_barrier_success is not None
            and item.control_barrier_success is not None
        ]
        result.update(
            {
                "event_direction_rate": (
                    statistics.fmean(float(item.event_direction) for item in directional)
                    if directional
                    else None
                ),
                "control_direction_rate": (
                    statistics.fmean(float(item.control_direction) for item in directional)
                    if directional
                    else None
                ),
                "direction_lift": (
                    statistics.fmean(
                        float(item.event_direction) - float(item.control_direction)
                        for item in directional
                    )
                    if directional
                    else None
                ),
                "event_mean_signed_return": (
                    statistics.fmean(float(item.event_signed_return) for item in directional)
                    if directional
                    else None
                ),
                "control_mean_signed_return": (
                    statistics.fmean(float(item.control_signed_return) for item in directional)
                    if directional
                    else None
                ),
                "mean_signed_return_lift": (
                    statistics.fmean(
                        float(item.event_signed_return)
                        - float(item.control_signed_return)
                        for item in directional
                    )
                    if directional
                    else None
                ),
                "barrier_comparable_events": len(barriers),
                "event_barrier_success_rate": (
                    statistics.fmean(
                        float(item.event_barrier_success) for item in barriers
                    )
                    if barriers
                    else None
                ),
                "control_barrier_success_rate": (
                    statistics.fmean(
                        float(item.control_barrier_success) for item in barriers
                    )
                    if barriers
                    else None
                ),
                "barrier_success_lift": (
                    statistics.fmean(
                        float(item.event_barrier_success)
                        - float(item.control_barrier_success)
                        for item in barriers
                    )
                    if barriers
                    else None
                ),
            }
        )
    result["cluster_bootstrap"] = cluster_bootstrap_matched(observations, side)
    return result


def iter_context_indices(
    context: Context,
    bars_by_symbol: dict[str, list[Any]],
) -> Iterable[tuple[str, int]]:
    for symbol in sorted(context.all_symbols & set(bars_by_symbol)):
        for index, bar in enumerate(bars_by_symbol[symbol]):
            if (
                context.start <= bar.date <= context.end
                and symbol in context.symbols_on(bar.date)
            ):
                yield symbol, index


def collect_outcomes(
    context: Context,
    pair: PairConfig,
    event_key: str,
    horizon: int,
    bars_by_symbol: dict[str, list[Any]],
    states_by_pair: dict[str, dict[str, dict[str, Any]]],
    cooldown: bool,
) -> list[Outcome]:
    outcomes: list[Outcome] = []
    last_kept: dict[str, int] = defaultdict(lambda: -100_000)
    for symbol, index in iter_context_indices(context, bars_by_symbol):
        flags = states_by_pair[pair.key][symbol]["events"][event_key]
        if not flags[index]:
            continue
        if cooldown and index - last_kept[symbol] <= pair.primary_horizon:
            continue
        outcome = event_outcome(
            symbol, bars_by_symbol[symbol], index, horizon, pair.barrier
        )
        if outcome is None:
            continue
        outcomes.append(outcome)
        if cooldown:
            last_kept[symbol] = index
    return outcomes


def build_date_candidates(
    context: Context,
    pair: PairConfig,
    event_key: str,
    bars_by_symbol: dict[str, list[Any]],
    states_by_pair: dict[str, dict[str, dict[str, Any]]],
) -> dict[dt.date, list[tuple[str, int]]]:
    candidates: dict[dt.date, list[tuple[str, int]]] = defaultdict(list)
    for symbol, index in iter_context_indices(context, bars_by_symbol):
        state = states_by_pair[pair.key][symbol]
        if (
            state["eligibility"][event_key][index]
            and state["features"][index] is not None
            and not state["events"][event_key][index]
        ):
            candidates[bars_by_symbol[symbol][index].date].append((symbol, index))
    return candidates


def matched_observations(
    event_outcomes: Sequence[Outcome],
    context: Context,
    pair: PairConfig,
    event_key: str,
    bars_by_symbol: dict[str, list[Any]],
    states_by_pair: dict[str, dict[str, dict[str, Any]]],
) -> tuple[list[MatchedObservation], int]:
    side = EVENT_META[event_key]["side"]
    assert side in {"up", "down", None}
    candidates = build_date_candidates(
        context, pair, event_key, bars_by_symbol, states_by_pair
    )
    result: list[MatchedObservation] = []
    unmatched = 0
    for event in event_outcomes:
        event_feature = states_by_pair[pair.key][event.symbol]["features"][
            event.decision_index
        ]
        if event_feature is None:
            unmatched += 1
            continue
        possible: list[tuple[float, str, int, Outcome]] = []
        for symbol, index in candidates.get(event.decision_date, []):
            if symbol == event.symbol:
                continue
            feature = states_by_pair[pair.key][symbol]["features"][index]
            if feature is None:
                continue
            outcome = event_outcome(
                symbol,
                bars_by_symbol[symbol],
                index,
                event.horizon,
                pair.barrier,
            )
            if outcome is None:
                continue
            possible.append(
                (feature_distance(event_feature, feature), symbol, index, outcome)
            )
        possible.sort(key=lambda item: (item[0], item[1], item[2]))
        controls = [item[3] for item in possible[:CONTROL_COUNT]]
        if not controls:
            unmatched += 1
            continue
        event_signed = signed_return(event, side)
        control_signed_values = [signed_return(item, side) for item in controls]
        control_signed_values = [
            value for value in control_signed_values if value is not None
        ]
        event_barrier = barrier_result(event, side)
        control_barriers = [barrier_result(item, side) for item in controls]
        control_barriers = [value for value in control_barriers if value is not None]
        result.append(
            MatchedObservation(
                symbol=event.symbol,
                event_signed_return=event_signed,
                control_signed_return=(
                    statistics.fmean(control_signed_values)
                    if control_signed_values
                    else None
                ),
                event_direction=(
                    float(event_signed > 0) if event_signed is not None else None
                ),
                control_direction=(
                    statistics.fmean(float(value > 0) for value in control_signed_values)
                    if control_signed_values
                    else None
                ),
                event_barrier_success=event_barrier,
                control_barrier_success=(
                    statistics.fmean(control_barriers) if control_barriers else None
                ),
                event_change_hit=change_hit(event),
                control_change_hit=statistics.fmean(
                    change_hit(item) for item in controls
                ),
                event_raw_return=event.raw_return,
                control_raw_return=statistics.fmean(
                    item.raw_return for item in controls
                ),
                event_abs_return=abs(event.raw_return),
                control_abs_return=statistics.fmean(
                    abs(item.raw_return) for item in controls
                ),
            )
        )
    return result, unmatched


def context_summary(
    context: Context,
    pair: PairConfig,
    event_key: str,
    bars_by_symbol: dict[str, list[Any]],
    states_by_pair: dict[str, dict[str, dict[str, Any]]],
) -> dict[str, Any]:
    side = EVENT_META[event_key]["side"]
    assert side in {"up", "down", None}
    horizons: dict[str, Any] = {}
    for horizon in HORIZONS:
        raw = collect_outcomes(
            context,
            pair,
            event_key,
            horizon,
            bars_by_symbol,
            states_by_pair,
            cooldown=False,
        )
        non_overlapping = collect_outcomes(
            context,
            pair,
            event_key,
            horizon,
            bars_by_symbol,
            states_by_pair,
            cooldown=True,
        )
        matched, unmatched = matched_observations(
            non_overlapping,
            context,
            pair,
            event_key,
            bars_by_symbol,
            states_by_pair,
        )
        horizons[str(horizon)] = {
            "raw": summarize_outcomes(raw, side),
            "non_overlapping": summarize_outcomes(
                non_overlapping,
                side,
                bootstrap=horizon == pair.primary_horizon,
            ),
            "same_date_matched_control": {
                **summarize_matched(matched, side),
                "unmatched_events": unmatched,
                "controls_per_event_maximum": CONTROL_COUNT,
            },
        }
    annual: list[dict[str, Any]] = []
    if context.key in {"recent_point_in_time", "adverse_confirmation"}:
        for year in range(context.start.year, context.end.year + 1):
            year_context = Context(
                key=f"{context.key}_{year}",
                label=f"{context.label} {year}",
                start=dt.date(year, 1, 1),
                end=min(context.end, dt.date(year, 12, 31)),
                fixed_symbols=context.fixed_symbols,
                annual_symbols=context.annual_symbols,
            )
            outcomes = collect_outcomes(
                year_context,
                pair,
                event_key,
                pair.primary_horizon,
                bars_by_symbol,
                states_by_pair,
                cooldown=True,
            )
            annual.append(
                {
                    "year": year,
                    **summarize_outcomes(outcomes, side),
                }
            )
    return {
        "event": event_key,
        "label": EVENT_META[event_key]["label"],
        "side": side,
        "product_semantics": EVENT_META[event_key]["product_semantics"],
        "primary_horizon": pair.primary_horizon,
        "barrier": pair.barrier,
        "horizons": horizons,
        "annual_primary_horizon": annual,
    }


def contexts_from_baseline(
    baseline: dict[str, Any], available: set[str]
) -> list[Context]:
    cohorts = {
        int(year): frozenset(payload["symbols"]) & available
        for year, payload in baseline["cohorts"].items()
    }
    recent_union = set().union(cohorts[2024], cohorts[2025], cohorts[2026])
    early_union = set().union(
        cohorts[2015], cohorts[2021], cohorts[2022], cohorts[2023]
    )
    adverse = frozenset(early_union - recent_union)
    end = dt.date.fromisoformat(baseline["metadata"]["requested_end"])
    return [
        Context(
            key="development",
            label="2015—2020 开发观察",
            start=dt.date(2015, 1, 1),
            end=dt.date(2020, 12, 31),
            fixed_symbols=cohorts[2015],
            annual_symbols=None,
        ),
        Context(
            key="validation",
            label="2021—2023 时间验证",
            start=dt.date(2021, 1, 1),
            end=dt.date(2023, 12, 31),
            fixed_symbols=cohorts[2021],
            annual_symbols=None,
        ),
        Context(
            key="recent_point_in_time",
            label="2024—2026 逐年时点样本",
            start=dt.date(2024, 1, 1),
            end=end,
            fixed_symbols=None,
            annual_symbols={
                year: cohorts[year] for year in (2024, 2025, 2026)
            },
        ),
        Context(
            key="adverse_confirmation",
            label="2024—2026 逆风历史成分样本",
            start=dt.date(2024, 1, 1),
            end=end,
            fixed_symbols=adverse,
            annual_symbols=None,
        ),
    ]


def run(args: argparse.Namespace) -> dict[str, Any]:
    baseline = json.loads(args.baseline.read_text(encoding="utf-8"))
    metadata = baseline["metadata"]
    bars_by_symbol: dict[str, list[Any]] = {}
    mismatches: list[str] = []
    missing: list[str] = []
    for symbol, expected in sorted(baseline["universe"].items()):
        path = base.cache_path(args.cache_dir, symbol, metadata)
        if not path.exists():
            missing.append(symbol)
            continue
        bars = base.load_bars(path)
        actual = base.bar_manifest(bars)
        expected_core = {
            key: expected.get(key)
            for key in ("rows", "first_date", "last_date", "sha256")
        }
        if actual != expected_core:
            mismatches.append(symbol)
            continue
        bars_by_symbol[symbol] = bars
    if missing or mismatches:
        raise RuntimeError(
            f"source validation failed: missing={missing[:5]} mismatches={mismatches[:5]}"
        )

    values_by_symbol = {
        symbol: base.indicators(bars) for symbol, bars in bars_by_symbol.items()
    }
    states_by_pair: dict[str, dict[str, dict[str, Any]]] = {}
    for pair in PAIR_CONFIGS:
        states_by_pair[pair.key] = {
            symbol: build_pair_state(bars, values_by_symbol[symbol], pair)
            for symbol, bars in bars_by_symbol.items()
        }
        print(f"built state: {pair.key}", file=sys.stderr, flush=True)

    contexts = contexts_from_baseline(baseline, set(bars_by_symbol))
    study: dict[str, Any] = {}
    for pair in PAIR_CONFIGS:
        pair_contexts: dict[str, Any] = {}
        for context in contexts:
            pair_contexts[context.key] = {
                "label": context.label,
                "start": context.start.isoformat(),
                "end": context.end.isoformat(),
                "symbols": len(context.all_symbols),
                "events": {
                    event_key: context_summary(
                        context,
                        pair,
                        event_key,
                        bars_by_symbol,
                        states_by_pair,
                    )
                    for event_key in EVENT_META
                },
            }
            print(
                f"summarized: {pair.key} / {context.key}",
                file=sys.stderr,
                flush=True,
            )
        study[pair.key] = {
            "label": pair.label,
            "configuration": dataclasses.asdict(pair),
            "contexts": pair_contexts,
        }

    source_hash = hashlib.sha256(args.baseline.read_bytes()).hexdigest()
    script_hash = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    result = {
        "metadata": {
            "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
            "purpose": "non-trading MA/volume turning-point marker event study",
            "script_sha256": script_hash,
            "base_script_sha256": hashlib.sha256(BASE_PATH.read_bytes()).hexdigest(),
            "source_artifact": str(args.baseline),
            "source_artifact_sha256": source_hash,
            "provider": metadata["provider"],
            "adjustment": metadata["adjustment"],
            "frequency": "daily",
            "requested_start": metadata["requested_start"],
            "requested_end": metadata["requested_end"],
            "outcome_clock": (
                "event known at signal close; outcome starts at next open and ends "
                "at the close N trading days after the signal"
            ),
            "event_grid_frozen_before_evaluation": True,
            "no_parameter_selection": True,
            "event_count": len(EVENT_META) * len(PAIR_CONFIGS),
            "horizons": list(HORIZONS),
            "matching": (
                "up to three nearest same-date, other-symbol controls satisfying "
                "the same pre-event price/MA state but not the defining event"
            ),
            "limitations": [
                "This dataset was inspected in earlier related research, so the study is a locked retrospective confirmation rather than a pristine untouched holdout.",
                "Point-in-time cohorts reduce but do not eliminate index-selection and survivorship bias.",
                "Daily OHLCV cannot establish intraday order path when both barriers are crossed on one bar.",
                "Matched controls reduce broad market and state confounding but do not prove causality.",
                "Historical event frequencies and conditional outcomes cannot guarantee future behavior.",
            ],
        },
        "source_validation": {
            "symbols": len(bars_by_symbol),
            "rows": sum(len(bars) for bars in bars_by_symbol.values()),
            "manifest_mismatches": mismatches,
            "missing_cache": missing,
        },
        "event_definitions": {
            "common": {
                "volume_dry_current": "Volume / VMA20 <= 0.70",
                "volume_dry_broad": "VMA5 / VMA20 <= 0.85",
                "reacceleration_volume": "1.50 <= Volume / VMA20 <= 3.50",
                "huge_volume": "Volume / VMA20 >= 2.50",
                "strong_close": "Close > Open and close location >= 0.70",
                "weak_close": "close location <= 0.35",
                "close_location": "(Close - Low) / (High - Low)",
            },
            "pair_specific": {
                pair.key: dataclasses.asdict(pair) for pair in PAIR_CONFIGS
            },
            "events": EVENT_META,
        },
        "contexts": {
            context.key: {
                "label": context.label,
                "start": context.start.isoformat(),
                "end": context.end.isoformat(),
                "symbols": len(context.all_symbols),
                "membership": (
                    "fixed" if context.fixed_symbols is not None else "annual point-in-time"
                ),
            }
            for context in contexts
        },
        "study": study,
    }
    return base.round_floats(result)


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
