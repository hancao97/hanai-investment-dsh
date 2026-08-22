#!/usr/bin/env python3
"""Confirmation study for revised moving-average and volume rules.

The first MA/volume grid exposed a structural contradiction: a reclaim of MA20
could be followed immediately by a "trend" exit merely because MA20 was still
below MA60.  This second, predeclared grid adds a minimum holding period and
requires a new deterioration event before a moving-average exit.

Development uses 2015-2020 and 2021-2023 only.  After a single specification is
selected, it is evaluated once on an adverse 2024-2026 temporal confirmation
set: earlier point-in-time index constituents that are absent from every
2024/2025/2026 cohort.  No candidate sees confirmation outcomes during model
selection.
"""

from __future__ import annotations

import argparse
import dataclasses
import datetime as dt
import hashlib
import importlib.util
import json
import math
import statistics
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any, Sequence


BASE_PATH = Path(__file__).with_name("ma-volume-signal-study.py")
BASE_SPEC = importlib.util.spec_from_file_location("ma_volume_signal_base", BASE_PATH)
if BASE_SPEC is None or BASE_SPEC.loader is None:  # pragma: no cover
    raise RuntimeError(f"cannot import {BASE_PATH}")
base = importlib.util.module_from_spec(BASE_SPEC)
sys.modules[BASE_SPEC.name] = base
BASE_SPEC.loader.exec_module(base)


@dataclasses.dataclass(frozen=True)
class PairSpec:
    entry_family: str
    entry_params: dict[str, float | int]
    exit_profile: str

    @property
    def key(self) -> str:
        params = {**self.entry_params, "exit_profile": self.exit_profile}
        bits = ",".join(f"{key}={params[key]}" for key in sorted(params))
        return f"{self.entry_family}[{bits}]"


@dataclasses.dataclass(frozen=True)
class DirectionalSellSpec:
    family: str
    params: dict[str, float | int]

    @property
    def key(self) -> str:
        bits = ",".join(f"{key}={self.params[key]}" for key in sorted(self.params))
        return f"{self.family}[{bits}]"


EXIT_PROFILES: dict[str, dict[str, float | int | None]] = {
    "ma10_defense": {
        "minimum_hold": 3,
        "stop": 0.08,
        "target": 0.20,
        "max_hold": 20,
    },
    "ma20_swing": {
        "minimum_hold": 5,
        "stop": 0.10,
        "target": 0.25,
        "max_hold": 40,
    },
    "ma20_time20": {
        "minimum_hold": 5,
        "stop": 0.10,
        "target": 0.25,
        "max_hold": 20,
    },
    "ma60_trend": {
        "minimum_hold": 10,
        "stop": 0.12,
        "target": None,
        "max_hold": 60,
    },
}


def pair_grid() -> list[PairSpec]:
    entries: list[tuple[str, dict[str, float | int]]] = []
    for below_fraction in (0.50, 0.75):
        for trigger_volume in (1.20, 1.50):
            entries.append(
                (
                    "ma20_reclaim",
                    {
                        "below_fraction": below_fraction,
                        "trigger_volume": trigger_volume,
                    },
                )
            )
    for dry_ratio in (0.50, 0.70):
        for drawdown in (0.15, 0.25):
            for below_fraction in (0.50, 0.75):
                for trigger_volume in (1.20, 1.50):
                    entries.append(
                        (
                            "dryup_ma20_reclaim",
                            {
                                "dry_ratio": dry_ratio,
                                "drawdown": drawdown,
                                "below_fraction": below_fraction,
                                "trigger_volume": trigger_volume,
                                "setup_window": 20,
                            },
                        )
                    )
    for dry_ratio in (0.60, 0.80):
        for trigger_volume in (0.80, 1.20):
            entries.append(
                (
                    "trend_dryup_resume",
                    {
                        "dry_ratio": dry_ratio,
                        "trigger_volume": trigger_volume,
                        "setup_window": 10,
                    },
                )
            )
    return [
        PairSpec(family, params, profile)
        for family, params in entries
        for profile in EXIT_PROFILES
    ]


def directional_sell_grid() -> list[DirectionalSellSpec]:
    specs: list[DirectionalSellSpec] = []
    for period in (5, 10, 20):
        for prior_gain in (0.10, 0.20):
            for volume_ratio in (0.80, 1.20, 1.50):
                for confirmation in (1, 2):
                    specs.append(
                        DirectionalSellSpec(
                            "ma_break_after_gain",
                            {
                                "period": period,
                                "prior_gain": prior_gain,
                                "volume_ratio": volume_ratio,
                                "confirmation": confirmation,
                            },
                        )
                    )
    for period in (10, 20):
        for prior_gain in (0.15, 0.30):
            for climax_volume in (2.0, 3.0):
                for setup_window in (5, 10):
                    specs.append(
                        DirectionalSellSpec(
                            "weak_climax_then_break",
                            {
                                "period": period,
                                "prior_gain": prior_gain,
                                "climax_volume": climax_volume,
                                "setup_window": setup_window,
                            },
                        )
                    )
    for prior_gain in (0.10, 0.20):
        for volume_ratio in (0.80, 1.20):
            specs.append(
                DirectionalSellSpec(
                    "ma_stack_break_after_gain",
                    {"prior_gain": prior_gain, "volume_ratio": volume_ratio},
                )
            )
    return specs


def entry_flags(
    bars: Sequence[Any], values: dict[str, list[float | None]], spec: PairSpec
) -> list[bool]:
    flags = [False] * len(bars)
    p = spec.entry_params
    for index in range(121, len(bars)):
        bar = bars[index]
        previous = bars[index - 1]
        ma5 = values["ma5"][index]
        ma20 = values["ma20"][index]
        ma60 = values["ma60"][index]
        previous_ma20 = values["ma20"][index - 1]
        vol20 = values["vol20"][index]
        if not base.finite(ma5, ma20, ma60, previous_ma20, vol20):
            continue
        assert ma5 is not None and ma20 is not None and ma60 is not None
        assert previous_ma20 is not None and vol20 is not None
        if vol20 <= 0:
            continue
        current_volume_ratio = bar.volume / vol20

        if spec.entry_family in {"ma20_reclaim", "dryup_ma20_reclaim"}:
            below = base.recent_count(
                index,
                20,
                lambda position: (
                    values["ma20"][position] is not None
                    and bars[position].close < float(values["ma20"][position])
                ),
            )
            common = (
                below / 20 >= float(p["below_fraction"])
                and previous.close <= previous_ma20
                and bar.close > ma20
                and bar.close > bar.open
                and base.close_location(bar) >= 0.65
                and current_volume_ratio >= float(p["trigger_volume"])
                and current_volume_ratio <= 3.50
            )
            if spec.entry_family == "ma20_reclaim":
                flags[index] = common
                continue

            def was_dry_and_depressed(position: int) -> bool:
                vol5 = values["vol5"][position]
                vol60 = values["vol60"][position]
                setup_ma20 = values["ma20"][position]
                prior_high = values["high60"][position]
                return (
                    base.finite(vol5, vol60, setup_ma20, prior_high)
                    and float(vol60 or 0) > 0
                    and float(prior_high or 0) > 0
                    and float(vol5 or 0) / float(vol60 or 1)
                    <= float(p["dry_ratio"])
                    and bars[position].close <= float(setup_ma20 or 0)
                    and bars[position].close / float(prior_high or 1) - 1
                    <= -float(p["drawdown"])
                )

            flags[index] = common and base.recent_any(
                index, int(p["setup_window"]), was_dry_and_depressed
            )
        elif spec.entry_family == "trend_dryup_resume":

            def was_dry_pullback(position: int) -> bool:
                vol5 = values["vol5"][position]
                vol60 = values["vol60"][position]
                setup_ma20 = values["ma20"][position]
                setup_ma60 = values["ma60"][position]
                return (
                    base.finite(vol5, vol60, setup_ma20, setup_ma60)
                    and float(vol60 or 0) > 0
                    and float(vol5 or 0) / float(vol60 or 1)
                    <= float(p["dry_ratio"])
                    and float(setup_ma20 or 0) > float(setup_ma60 or 0)
                    and bars[position].low <= float(setup_ma20 or 0) * 1.02
                    and bars[position].close >= float(setup_ma20 or 0) * 0.97
                )

            flags[index] = (
                ma20 > ma60
                and base.recent_any(
                    index, int(p["setup_window"]), was_dry_pullback
                )
                and bar.close > ma5
                and bar.close > previous.high
                and bar.close > bar.open
                and base.close_location(bar) >= 0.60
                and current_volume_ratio >= float(p["trigger_volume"])
                and current_volume_ratio <= 3.50
            )
        else:  # pragma: no cover
            raise ValueError(spec.entry_family)
    return flags


def paired_exit_reason(
    bars: Sequence[Any],
    values: dict[str, list[float | None]],
    index: int,
    age: int,
    raw_return: float,
    profile_name: str,
) -> str | None:
    profile = EXIT_PROFILES[profile_name]
    if raw_return <= -float(profile["stop"] or 0):
        return "close_stop"
    if profile["target"] is not None and raw_return >= float(profile["target"]):
        return "close_profit_target"
    if age >= int(profile["max_hold"] or 0):
        return "max_hold"
    if age < int(profile["minimum_hold"] or 0) or index < 2:
        return None

    ma5 = values["ma5"][index]
    ma10 = values["ma10"][index]
    ma20 = values["ma20"][index]
    ma60 = values["ma60"][index]
    previous_ma5 = values["ma5"][index - 1]
    previous_ma10 = values["ma10"][index - 1]
    previous_ma20 = values["ma20"][index - 1]
    previous_ma60 = values["ma60"][index - 1]
    earlier_ma10 = values["ma10"][index - 2]
    earlier_ma20 = values["ma20"][index - 2]
    vol20 = values["vol20"][index]
    if not base.finite(
        ma5,
        ma10,
        ma20,
        ma60,
        previous_ma5,
        previous_ma10,
        previous_ma20,
        previous_ma60,
        earlier_ma10,
        earlier_ma20,
        vol20,
    ):
        return None
    assert ma5 is not None and ma10 is not None and ma20 is not None and ma60 is not None
    assert previous_ma5 is not None and previous_ma10 is not None
    assert previous_ma20 is not None and previous_ma60 is not None
    assert earlier_ma10 is not None and earlier_ma20 is not None and vol20 is not None
    volume_ratio = bars[index].volume / vol20 if vol20 > 0 else 0
    two_below_ma10 = (
        bars[index - 2].close >= earlier_ma10
        and bars[index - 1].close < previous_ma10
        and bars[index].close < ma10
    )
    two_below_ma20 = (
        bars[index - 2].close >= earlier_ma20
        and bars[index - 1].close < previous_ma20
        and bars[index].close < ma20
    )
    ma5_cross_down = previous_ma5 >= previous_ma10 and ma5 < ma10
    ma20_cross_down = previous_ma20 >= previous_ma60 and ma20 < ma60
    gain20 = base.prior_return(bars, index, 20)
    confirmed_climax = (
        gain20 is not None
        and gain20 >= 0.20
        and volume_ratio >= 2.50
        and base.close_location(bars[index]) <= 0.40
        and bars[index].close < ma10
    )

    if confirmed_climax:
        return "weak_volume_climax_below_ma10"
    if profile_name == "ma10_defense" and (two_below_ma10 or ma5_cross_down):
        return "ma10_two_close_or_ma5_cross"
    if profile_name in {"ma20_swing", "ma20_time20"} and (
        two_below_ma20 or (ma5_cross_down and bars[index].close < ma10)
    ):
        return "ma20_two_close_or_ma5_cross_below_ma10"
    if profile_name == "ma60_trend" and (
        ma20_cross_down or (two_below_ma20 and volume_ratio >= 1.20)
    ):
        return "ma20_ma60_cross_or_volume_break"
    return None


def simulate_pair(
    symbol: str,
    bars: Sequence[Any],
    values: dict[str, list[float | None]],
    spec: PairSpec,
    friction_multiplier: float = 1.0,
) -> Any:
    entries = entry_flags(bars, values, spec)
    trades: list[Any] = []
    pending_entry: int | None = None
    pending_exit: tuple[int, str] | None = None
    entry_signal: int | None = None
    entry_index: int | None = None
    entry_raw: float | None = None
    entry_effective: float | None = None
    in_position = False
    skipped_limit_up = 0
    delayed_limit_down = 0
    paired_exit_count = 0

    for index, bar in enumerate(bars):
        if pending_exit is not None and in_position and entry_index is not None:
            if base.unavailable_at_limit(bar, "sell"):
                delayed_limit_down += 1
            else:
                signal_index, reason = pending_exit
                assert entry_signal is not None and entry_raw is not None
                assert entry_effective is not None
                exit_effective = base.execution_prices(
                    bar.open, "sell", friction_multiplier
                )
                trades.append(
                    base.Trade(
                        symbol=symbol,
                        spec_key=spec.key,
                        entry_signal_date=bars[entry_signal].date,
                        entry_date=bars[entry_index].date,
                        entry_index=entry_index,
                        entry_price=entry_raw,
                        exit_signal_date=bars[signal_index].date,
                        exit_date=bar.date,
                        exit_index=index,
                        exit_price=bar.open,
                        hold_days=index - entry_index,
                        net_return=exit_effective / entry_effective - 1,
                        exit_reason=reason,
                    )
                )
                in_position = False
                entry_signal = None
                entry_index = None
                entry_raw = None
                entry_effective = None
                pending_exit = None

        if pending_entry is not None and not in_position and pending_exit is None:
            if base.unavailable_at_limit(bar, "buy"):
                skipped_limit_up += 1
            else:
                entry_signal = pending_entry
                entry_index = index
                entry_raw = bar.open
                entry_effective = base.execution_prices(
                    bar.open, "buy", friction_multiplier
                )
                in_position = True
            pending_entry = None

        if in_position and entry_index is not None and pending_exit is None:
            assert entry_raw is not None
            age = index - entry_index
            if age > 0:
                reason = paired_exit_reason(
                    bars,
                    values,
                    index,
                    age,
                    bar.close / entry_raw - 1,
                    spec.exit_profile,
                )
                if reason is not None:
                    paired_exit_count += 1
                    pending_exit = (index, reason)
        elif not in_position and index + 1 < len(bars) and entries[index]:
            pending_entry = index

    if in_position and entry_index is not None and len(bars) - 1 > entry_index:
        assert entry_signal is not None and entry_raw is not None
        assert entry_effective is not None
        last = bars[-1]
        exit_effective = base.execution_prices(
            last.close, "sell", friction_multiplier
        )
        trades.append(
            base.Trade(
                symbol=symbol,
                spec_key=spec.key,
                entry_signal_date=bars[entry_signal].date,
                entry_date=bars[entry_index].date,
                entry_index=entry_index,
                entry_price=entry_raw,
                exit_signal_date=last.date,
                exit_date=last.date,
                exit_index=len(bars) - 1,
                exit_price=last.close,
                hold_days=len(bars) - 1 - entry_index,
                net_return=exit_effective / entry_effective - 1,
                exit_reason="end_of_data",
            )
        )
        in_position = False

    return base.Simulation(
        trades=trades,
        raw_buy_signal_count=sum(entries),
        paired_exit_signal_count=paired_exit_count,
        skipped_limit_up_entries=skipped_limit_up,
        delayed_limit_down_exits=delayed_limit_down,
        open_position_at_end=in_position,
    )


def directional_sell_flags(
    bars: Sequence[Any],
    values: dict[str, list[float | None]],
    spec: DirectionalSellSpec,
) -> list[bool]:
    flags = [False] * len(bars)
    p = spec.params
    for index in range(121, len(bars)):
        bar = bars[index]
        vol20 = values["vol20"][index]
        if vol20 is None or vol20 <= 0:
            continue
        volume_ratio = bar.volume / vol20
        if spec.family == "ma_break_after_gain":
            period = int(p["period"])
            ma = values[f"ma{period}"][index]
            previous_ma = values[f"ma{period}"][index - 1]
            gain = base.prior_return(bars, index - 1, 20)
            if not base.finite(ma, previous_ma, gain):
                continue
            assert ma is not None and previous_ma is not None and gain is not None
            if int(p["confirmation"]) == 1:
                broke = bars[index - 1].close >= previous_ma and bar.close < ma
            else:
                earlier_ma = values[f"ma{period}"][index - 2]
                broke = (
                    earlier_ma is not None
                    and bars[index - 2].close >= earlier_ma
                    and bars[index - 1].close < previous_ma
                    and bar.close < ma
                )
            flags[index] = (
                gain >= float(p["prior_gain"])
                and volume_ratio >= float(p["volume_ratio"])
                and base.close_location(bar) <= 0.55
                and broke
            )
        elif spec.family == "weak_climax_then_break":
            period = int(p["period"])
            ma = values[f"ma{period}"][index]
            previous_ma = values[f"ma{period}"][index - 1]
            if ma is None or previous_ma is None:
                continue

            def weak_climax(position: int) -> bool:
                setup_vol20 = values["vol20"][position]
                gain = base.prior_return(bars, position, 20)
                return (
                    setup_vol20 is not None
                    and setup_vol20 > 0
                    and gain is not None
                    and gain >= float(p["prior_gain"])
                    and bars[position].volume / setup_vol20
                    >= float(p["climax_volume"])
                    and base.close_location(bars[position]) <= 0.40
                )

            flags[index] = (
                base.recent_any(index, int(p["setup_window"]), weak_climax)
                and bars[index - 1].close >= previous_ma
                and bar.close < ma
                and base.close_location(bar) <= 0.55
            )
        elif spec.family == "ma_stack_break_after_gain":
            gain = base.prior_return(bars, index - 1, 20)
            ma5 = values["ma5"][index]
            ma10 = values["ma10"][index]
            ma20 = values["ma20"][index]
            previous_ma5 = values["ma5"][index - 1]
            previous_ma10 = values["ma10"][index - 1]
            if not base.finite(gain, ma5, ma10, ma20, previous_ma5, previous_ma10):
                continue
            flags[index] = (
                float(gain or 0) >= float(p["prior_gain"])
                and float(previous_ma5 or 0) >= float(previous_ma10 or 0)
                and float(ma5 or 0) < float(ma10 or 0)
                and bar.close < float(ma20 or 0)
                and volume_ratio >= float(p["volume_ratio"])
                and base.close_location(bar) <= 0.55
            )
        else:  # pragma: no cover
            raise ValueError(spec.family)
    return flags


def development_trade_score(
    train: dict[str, Any], validation: dict[str, Any]
) -> float:
    if int(train["trades"]) < 80 or int(validation["trades"]) < 40:
        return -100 + min(int(train["trades"]), int(validation["trades"])) / 10_000
    worst_mean = min(
        float(train["mean_trade_return"] or -1),
        float(validation["mean_trade_return"] or -1),
    )
    worst_trimmed = min(
        float(train["mean_return_without_top_5pct"] or -1),
        float(validation["mean_return_without_top_5pct"] or -1),
    )
    worst_pf = min(
        float(train["profit_factor"] or 0), float(validation["profit_factor"] or 0)
    )
    worst_win = min(
        float(train["win_rate"] or 0), float(validation["win_rate"] or 0)
    )
    worst_cagr = min(
        float(train["median_symbol_cagr"]),
        float(validation["median_symbol_cagr"]),
    )
    worst_drawdown = max(
        float(train["median_symbol_closed_trade_max_drawdown"]),
        float(validation["median_symbol_closed_trade_max_drawdown"]),
    )
    return (
        worst_mean
        + 0.50 * worst_trimmed
        + 0.02 * (worst_pf - 1)
        + 0.04 * (worst_win - 0.45)
        + 0.25 * worst_cagr
        - 0.10 * worst_drawdown
    )


def development_sell_score(
    train: dict[str, Any], validation: dict[str, Any]
) -> float:
    left = train["non_overlapping_cooldown"]
    right = validation["non_overlapping_cooldown"]
    if int(left["signals"]) < 60 or int(right["signals"]) < 30:
        return -100 + min(int(left["signals"]), int(right["signals"])) / 10_000
    worst_rate = min(
        float(left["direction_correct_rate"] or 0),
        float(right["direction_correct_rate"] or 0),
    )
    worst_mean = min(
        float(left["mean_signed_return"] or -1),
        float(right["mean_signed_return"] or -1),
    )
    return worst_rate - 0.5 + 4 * worst_mean


def reserve_trade_gates(
    summary: dict[str, Any],
    double_friction: dict[str, Any],
    annual: Sequence[dict[str, Any]],
) -> dict[str, Any]:
    bootstrap = summary.get("cluster_bootstrap", {})
    win_ci = bootstrap.get("win_rate_95ci")
    mean_ci = bootstrap.get("mean_return_95ci")
    gates = {
        "at_least_150_completed_confirmation_trades": int(summary["trades"]) >= 150,
        "confirmation_win_rate_at_least_52pct": (summary["win_rate"] or 0) >= 0.52,
        "win_rate_ci_lower_at_least_48pct": bool(win_ci)
        and float(win_ci[0]) >= 0.48,
        "mean_net_return_positive": (summary["mean_trade_return"] or 0) > 0,
        "mean_return_ci_lower_positive": bool(mean_ci) and float(mean_ci[0]) > 0,
        "profit_factor_at_least_1_20": (summary["profit_factor"] or 0) >= 1.20,
        "positive_without_top_5pct_trades": (
            summary["mean_return_without_top_5pct"] or 0
        )
        > 0,
        "positive_under_double_friction": (
            double_friction["mean_trade_return"] or 0
        )
        > 0,
        "positive_mean_in_at_least_2_of_3_years": sum(
            (item["strategy"]["mean_trade_return"] or 0) > 0 for item in annual
        )
        >= 2,
        "median_symbol_cagr_positive": summary["median_symbol_cagr"] > 0,
    }
    return {
        "historical_gate_not_future_guarantee": True,
        "gates": gates,
        "passed": all(gates.values()),
        "passed_count": sum(gates.values()),
        "total_count": len(gates),
    }


def reserve_sell_gates(
    summary: dict[str, Any], annual: Sequence[dict[str, Any]]
) -> dict[str, Any]:
    metrics = summary["non_overlapping_cooldown"]
    bootstrap = metrics.get("cluster_bootstrap", {})
    rate_ci = bootstrap.get("direction_rate_95ci")
    mean_ci = bootstrap.get("mean_signed_return_95ci")
    gates = {
        "at_least_100_non_overlapping_confirmation_signals": int(metrics["signals"])
        >= 100,
        "direction_correct_rate_at_least_55pct": (
            metrics["direction_correct_rate"] or 0
        )
        >= 0.55,
        "direction_ci_lower_above_50pct": bool(rate_ci) and float(rate_ci[0]) > 0.50,
        "mean_signed_return_positive": (metrics["mean_signed_return"] or 0) > 0,
        "mean_signed_return_ci_lower_positive": bool(mean_ci)
        and float(mean_ci[0]) > 0,
        "direction_above_50pct_in_at_least_2_of_3_years": sum(
            (
                item["strategy"]["non_overlapping_cooldown"][
                    "direction_correct_rate"
                ]
                or 0
            )
            > 0.5
            for item in annual
        )
        >= 2,
    }
    return {
        "historical_gate_not_future_guarantee": True,
        "gates": gates,
        "passed": all(gates.values()),
        "passed_count": sum(gates.values()),
        "total_count": len(gates),
    }


def run(args: argparse.Namespace) -> dict[str, Any]:
    baseline = json.loads(args.baseline.read_text(encoding="utf-8"))
    metadata = baseline["metadata"]
    cohorts = {
        int(year): set(payload["symbols"])
        for year, payload in baseline["cohorts"].items()
    }
    bars_by_symbol: dict[str, list[Any]] = {}
    for symbol, expected in sorted(baseline["universe"].items()):
        path = base.cache_path(args.cache_dir, symbol, metadata)
        if not path.exists():
            raise RuntimeError(f"missing cache file: {path}")
        bars = base.load_bars(path)
        actual = base.bar_manifest(bars)
        expected_core = {
            key: expected.get(key)
            for key in ("rows", "first_date", "last_date", "sha256")
        }
        if actual != expected_core:
            raise RuntimeError(f"manifest mismatch for {symbol}")
        bars_by_symbol[symbol] = bars
    values_by_symbol = {
        symbol: base.indicators(bars) for symbol, bars in bars_by_symbol.items()
    }

    train_start, train_end = dt.date(2015, 1, 1), dt.date(2020, 12, 31)
    validation_start, validation_end = dt.date(2021, 1, 1), dt.date(2023, 12, 31)
    confirmation_start = dt.date(2024, 1, 1)
    confirmation_end = dt.date.fromisoformat(metadata["requested_end"])
    early_symbols = set().union(
        cohorts[2015], cohorts[2021], cohorts[2022], cohorts[2023]
    )
    recent_symbols = set().union(cohorts[2024], cohorts[2025], cohorts[2026])
    confirmation_symbols = (early_symbols - recent_symbols) & set(bars_by_symbol)
    development_symbols = (cohorts[2015] | cohorts[2021]) & set(bars_by_symbol)

    pair_candidates = pair_grid()
    pair_development: dict[str, dict[str, Any]] = {}
    for number, spec in enumerate(pair_candidates, 1):
        simulations = {
            symbol: simulate_pair(
                symbol, bars_by_symbol[symbol], values_by_symbol[symbol], spec
            )
            for symbol in sorted(development_symbols)
        }
        train = base.summarize_trades(
            simulations, train_start, train_end, cohorts[2015]
        )
        validation = base.summarize_trades(
            simulations, validation_start, validation_end, cohorts[2021]
        )
        pair_development[spec.key] = {
            "entry_family": spec.entry_family,
            "entry_params": spec.entry_params,
            "exit_profile": spec.exit_profile,
            "development_score": development_trade_score(train, validation),
            "train": train,
            "validation": validation,
        }
        if number % 12 == 0 or number == len(pair_candidates):
            print(
                f"confirmation buy development {number}/{len(pair_candidates)}",
                file=sys.stderr,
                flush=True,
            )
    selected_pair = max(
        pair_candidates,
        key=lambda item: pair_development[item.key]["development_score"],
    )

    confirmation_simulations = {
        symbol: simulate_pair(
            symbol,
            bars_by_symbol[symbol],
            values_by_symbol[symbol],
            selected_pair,
        )
        for symbol in sorted(confirmation_symbols)
    }
    confirmation_summary = base.summarize_trades(
        confirmation_simulations,
        confirmation_start,
        confirmation_end,
        confirmation_symbols,
        bootstrap=True,
    )
    double_friction_simulations = {
        symbol: simulate_pair(
            symbol,
            bars_by_symbol[symbol],
            values_by_symbol[symbol],
            selected_pair,
            friction_multiplier=2.0,
        )
        for symbol in sorted(confirmation_symbols)
    }
    double_friction_summary = base.summarize_trades(
        double_friction_simulations,
        confirmation_start,
        confirmation_end,
        confirmation_symbols,
    )
    selected_entry_flags = {
        symbol: entry_flags(
            bars_by_symbol[symbol], values_by_symbol[symbol], selected_pair
        )
        for symbol in sorted(confirmation_symbols)
    }
    confirmation_event_study = {
        str(horizon): base.summarize_events(
            selected_entry_flags,
            bars_by_symbol,
            "buy",
            confirmation_start,
            confirmation_end,
            confirmation_symbols,
            horizon,
            bootstrap=horizon == 20,
        )
        for horizon in base.HORIZONS
    }
    unconditional_flags = {
        symbol: [index >= 121 for index in range(len(bars_by_symbol[symbol]))]
        for symbol in sorted(confirmation_symbols)
    }
    unconditional_event_study = {
        str(horizon): base.summarize_events(
            unconditional_flags,
            bars_by_symbol,
            "buy",
            confirmation_start,
            confirmation_end,
            confirmation_symbols,
            horizon,
            bootstrap=horizon == 20,
        )
        for horizon in base.HORIZONS
    }
    confirmation_annual = [
        {
            "year": year,
            "strategy": base.summarize_trades(
                confirmation_simulations,
                dt.date(year, 1, 1),
                confirmation_end
                if year == confirmation_end.year
                else dt.date(year, 12, 31),
                confirmation_symbols,
            ),
            "market": base.market_regime(
                bars_by_symbol,
                confirmation_symbols,
                dt.date(year, 1, 1),
                confirmation_end
                if year == confirmation_end.year
                else dt.date(year, 12, 31),
            ),
        }
        for year in (2024, 2025, 2026)
    ]
    pair_gates = reserve_trade_gates(
        confirmation_summary, double_friction_summary, confirmation_annual
    )

    sell_candidates = directional_sell_grid()
    sell_development: dict[str, dict[str, Any]] = {}
    for number, spec in enumerate(sell_candidates, 1):
        flags = {
            symbol: directional_sell_flags(
                bars_by_symbol[symbol], values_by_symbol[symbol], spec
            )
            for symbol in sorted(development_symbols)
        }
        train = base.summarize_events(
            flags,
            bars_by_symbol,
            "sell",
            train_start,
            train_end,
            cohorts[2015],
            20,
        )
        validation = base.summarize_events(
            flags,
            bars_by_symbol,
            "sell",
            validation_start,
            validation_end,
            cohorts[2021],
            20,
        )
        sell_development[spec.key] = {
            "family": spec.family,
            "params": spec.params,
            "development_score": development_sell_score(train, validation),
            "train": train,
            "validation": validation,
        }
        if number % 10 == 0 or number == len(sell_candidates):
            print(
                f"confirmation sell development {number}/{len(sell_candidates)}",
                file=sys.stderr,
                flush=True,
            )
    selected_sell = max(
        sell_candidates,
        key=lambda item: sell_development[item.key]["development_score"],
    )
    confirmation_sell_flags = {
        symbol: directional_sell_flags(
            bars_by_symbol[symbol], values_by_symbol[symbol], selected_sell
        )
        for symbol in sorted(confirmation_symbols)
    }
    confirmation_sell_summary = base.summarize_events(
        confirmation_sell_flags,
        bars_by_symbol,
        "sell",
        confirmation_start,
        confirmation_end,
        confirmation_symbols,
        20,
        bootstrap=True,
    )
    confirmation_sell_event_study = {
        str(horizon): base.summarize_events(
            confirmation_sell_flags,
            bars_by_symbol,
            "sell",
            confirmation_start,
            confirmation_end,
            confirmation_symbols,
            horizon,
            bootstrap=horizon == 20,
        )
        for horizon in base.HORIZONS
    }
    confirmation_sell_annual = [
        {
            "year": year,
            "strategy": base.summarize_events(
                confirmation_sell_flags,
                bars_by_symbol,
                "sell",
                dt.date(year, 1, 1),
                confirmation_end
                if year == confirmation_end.year
                else dt.date(year, 12, 31),
                confirmation_symbols,
                20,
            ),
            "market": base.market_regime(
                bars_by_symbol,
                confirmation_symbols,
                dt.date(year, 1, 1),
                confirmation_end
                if year == confirmation_end.year
                else dt.date(year, 12, 31),
            ),
        }
        for year in (2024, 2025, 2026)
    ]
    sell_gates = reserve_sell_gates(
        confirmation_sell_summary, confirmation_sell_annual
    )

    sorted_pairs = sorted(
        pair_development.items(),
        key=lambda item: item[1]["development_score"],
        reverse=True,
    )
    sorted_sells = sorted(
        sell_development.items(),
        key=lambda item: item[1]["development_score"],
        reverse=True,
    )
    result = {
        "metadata": {
            "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
            "purpose": "post-diagnostic locked confirmation of revised MA/volume rules",
            "script_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            "base_script_sha256": hashlib.sha256(BASE_PATH.read_bytes()).hexdigest(),
            "source_artifact": str(args.baseline),
            "source_artifact_sha256": hashlib.sha256(
                args.baseline.read_bytes()
            ).hexdigest(),
            "provider": metadata["provider"],
            "adjustment": metadata["adjustment"],
            "execution": "signal at close; execute at next trading-day open",
            "selection_was_completed_before_confirmation_evaluation": True,
            "candidate_counts": {
                "paired_buy": len(pair_candidates),
                "directional_sell": len(sell_candidates),
            },
            "limitations": [
                "The confirmation set is deliberately adverse and not a representative market portfolio.",
                "The same securities may appear in development at earlier dates; only their 2024+ outcomes are held out.",
                "Historical accuracy cannot guarantee future realized returns.",
                "Daily bars cannot establish intraday order path or queue position.",
            ],
        },
        "sample": {
            "symbols": len(bars_by_symbol),
            "rows": sum(len(bars) for bars in bars_by_symbol.values()),
            "train": {
                "start": train_start.isoformat(),
                "end": train_end.isoformat(),
                "cohort": 2015,
                "symbols": len(cohorts[2015]),
            },
            "validation": {
                "start": validation_start.isoformat(),
                "end": validation_end.isoformat(),
                "cohort": 2021,
                "symbols": len(cohorts[2021]),
            },
            "adverse_temporal_confirmation": {
                "start": confirmation_start.isoformat(),
                "end": confirmation_end.isoformat(),
                "definition": (
                    "union(2015,2021,2022,2023 cohorts) minus "
                    "union(2024,2025,2026 cohorts)"
                ),
                "symbols": len(confirmation_symbols),
                "symbol_list": sorted(confirmation_symbols),
            },
        },
        "paired_buy": {
            "selected_spec": selected_pair.key,
            "entry_family": selected_pair.entry_family,
            "entry_params": selected_pair.entry_params,
            "exit_profile": selected_pair.exit_profile,
            "selection_basis": (
                "maximize the worst-case train/validation score before reading confirmation"
            ),
            "development": pair_development[selected_pair.key],
            "confirmation": confirmation_summary,
            "double_friction_confirmation": double_friction_summary,
            "confirmation_event_study": confirmation_event_study,
            "unconditional_confirmation_baseline": unconditional_event_study,
            "confirmation_annual": confirmation_annual,
            "release_gates": pair_gates,
            "top_10_development_candidates": [
                {"spec": key, **payload} for key, payload in sorted_pairs[:10]
            ],
            "all_development_candidates": pair_development,
        },
        "directional_sell": {
            "selected_spec": selected_sell.key,
            "family": selected_sell.family,
            "params": selected_sell.params,
            "selection_basis": (
                "maximize the worst-case train/validation direction score before reading confirmation"
            ),
            "development": sell_development[selected_sell.key],
            "confirmation": confirmation_sell_summary,
            "confirmation_event_study": confirmation_sell_event_study,
            "confirmation_annual": confirmation_sell_annual,
            "release_gates": sell_gates,
            "top_10_development_candidates": [
                {"spec": key, **payload} for key, payload in sorted_sells[:10]
            ],
            "all_development_candidates": sell_development,
        },
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
