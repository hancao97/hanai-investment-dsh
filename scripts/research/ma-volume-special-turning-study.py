#!/usr/bin/env python3
"""Supplementary causal study for two untested MA/volume chart patterns.

This study is a new, frozen research version.  It does not modify or inherit
the results of MA_VOLUME_TURN_V0.  The two families are:

* quiet doji pullback: a doji inside the already-defined quiet pullback state;
* deep-decline huge volume: exceptional volume after a causal, past-only deep
  drawdown, split by closing shape and by a later moving-average reclaim.

Every event is known at the signal close.  Outcomes start at the next open.
"Bottom" is deliberately not used as an event definition because a historical
bottom can only be known with future data.
"""

from __future__ import annotations

import argparse
import dataclasses
import datetime as dt
import hashlib
import importlib.util
import json
import math
import sys
from pathlib import Path
from typing import Any, Sequence


TURN_PATH = Path(__file__).with_name("ma-volume-turning-point-study.py")
TURN_SPEC = importlib.util.spec_from_file_location(
    "ma_volume_turning_point_base", TURN_PATH
)
if TURN_SPEC is None or TURN_SPEC.loader is None:  # pragma: no cover
    raise RuntimeError(f"cannot import {TURN_PATH}")
turn = importlib.util.module_from_spec(TURN_SPEC)
sys.modules[TURN_SPEC.name] = turn
TURN_SPEC.loader.exec_module(turn)
base = turn.base


STUDY_VERSION = "MA_VOLUME_SPECIAL_TURN_V0"
DEEP_DRAWDOWN = -0.25
HUGE_VOLUME_RATIO = 2.50
DOJI_BODY_RANGE_RATIO = 0.20
QUIET_CURRENT_RATIO = 0.70
QUIET_BROAD_RATIO = 0.85
DEEP_BELOW_MA20_DAYS = 10
CONFIRMATION_WINDOW = 5


EVENT_META: dict[str, dict[str, str | None]] = {
    "quiet_doji_pullback_isolated": {
        "label": "缩量十字星回踩（对照普通缩量回踩）",
        "side": "up",
        "product_semantics": "待补测：十字星增量",
    },
    "quiet_doji_pullback_combined": {
        "label": "缩量十字星回踩（对照所有相似回踩）",
        "side": "up",
        "product_semantics": "待补测：组合形态",
    },
    "deep_decline_huge_volume": {
        "label": "深跌区巨量",
        "side": None,
        "product_semantics": "待补测：分歧观察",
    },
    "deep_decline_huge_volume_strong": {
        "label": "深跌区巨量强收盘",
        "side": "up",
        "product_semantics": "待补测：承接候选",
    },
    "deep_decline_huge_volume_weak": {
        "label": "深跌区巨量弱收盘",
        "side": "down",
        "product_semantics": "待补测：恐慌延续候选",
    },
    "deep_decline_huge_volume_lower_shadow": {
        "label": "深跌区巨量长下影",
        "side": "up",
        "product_semantics": "待补测：下方承接候选",
    },
    "deep_decline_huge_volume_reclaim_fast": {
        "label": "深跌区巨量后站回快线",
        "side": "up",
        "product_semantics": "待补测：后续确认",
    },
}


def recent_flag(flags: Sequence[bool], index: int, window: int) -> bool:
    """Whether a flag occurred strictly before index within window bars."""

    return any(flags[max(0, index - window) : index])


def build_special_state(
    bars: Sequence[Any], values: dict[str, list[float | None]], pair: Any
) -> dict[str, Any]:
    length = len(bars)
    events = {key: [False] * length for key in EVENT_META}
    eligibility = {key: [False] * length for key in EVENT_META}
    features: list[Any | None] = [None] * length
    volatilities = turn.rolling_volatility(bars)

    fast_values = values[f"ma{pair.fast}"]
    slow_values = values[f"ma{pair.slow}"]
    ma20_values = values["ma20"]
    high60_values = values["high60"]

    for index in range(121, length):
        fast = fast_values[index]
        slow = slow_values[index]
        old_slow = slow_values[index - pair.slope_lookback]
        previous_fast = fast_values[index - 1]
        ma20 = ma20_values[index]
        vol5 = values["vol5"][index]
        vol20 = values["vol20"][index]
        high60 = high60_values[index]
        volatility20 = volatilities[index]
        if not base.finite(
            fast,
            slow,
            old_slow,
            previous_fast,
            ma20,
            vol5,
            vol20,
            high60,
            volatility20,
        ):
            continue
        assert fast is not None and slow is not None and old_slow is not None
        assert previous_fast is not None and ma20 is not None
        assert vol5 is not None and vol20 is not None and high60 is not None
        assert volatility20 is not None
        if min(fast, slow, ma20, vol20, high60) <= 0:
            continue

        bar = bars[index]
        volume_ratio = bar.volume / vol20
        broad_volume_ratio = vol5 / vol20
        close_location = base.close_location(bar)
        width = bar.high - bar.low
        doji = width > 0 and abs(bar.close - bar.open) / width <= DOJI_BODY_RANGE_RATIO

        # Family A: preserve the original pullback state and isolate only the
        # incremental information from a doji and quiet volume.
        prior_peak = turn.recent_high(bars, index, pair.pullback_lookback)
        drawdown_from_pullback_peak = (
            bar.close / prior_peak - 1 if prior_peak and prior_peak > 0 else None
        )
        uptrend = fast > slow and slow > old_slow
        pullback_base = (
            uptrend
            and drawdown_from_pullback_peak is not None
            and drawdown_from_pullback_peak <= -pair.pullback_depth
            and bar.low <= fast * 1.01
            and bar.close >= slow * 0.98
            and bar.close <= fast * 1.02
        )
        quiet_pullback = (
            pullback_base
            and volume_ratio <= QUIET_CURRENT_RATIO
            and broad_volume_ratio <= QUIET_BROAD_RATIO
        )
        quiet_doji = quiet_pullback and doji
        events["quiet_doji_pullback_isolated"][index] = quiet_doji
        events["quiet_doji_pullback_combined"][index] = quiet_doji
        eligibility["quiet_doji_pullback_isolated"][index] = quiet_pullback
        eligibility["quiet_doji_pullback_combined"][index] = pullback_base

        # Family B: causal substitute for "bottom".  All conditions use only
        # the current and past bars; the prior 60-day high excludes today.
        drawdown60 = bar.close / high60 - 1
        below_ma20_days = base.recent_count(
            index,
            20,
            lambda position: (
                ma20_values[position] is not None
                and bars[position].close < float(ma20_values[position])
            ),
        )
        deep_base = (
            drawdown60 <= DEEP_DRAWDOWN
            and below_ma20_days >= DEEP_BELOW_MA20_DAYS
            and bar.close <= ma20
        )
        huge = deep_base and volume_ratio >= HUGE_VOLUME_RATIO
        strong_close = bar.close > bar.open and close_location >= 0.70
        weak_close = close_location <= 0.35
        lower_shadow_ratio = (
            (min(bar.open, bar.close) - bar.low) / width if width > 0 else 0.0
        )
        long_lower_shadow = lower_shadow_ratio >= 0.45 and close_location >= 0.55

        eligibility["deep_decline_huge_volume"][index] = deep_base
        eligibility["deep_decline_huge_volume_strong"][index] = (
            deep_base and strong_close
        )
        eligibility["deep_decline_huge_volume_weak"][index] = deep_base and weak_close
        eligibility["deep_decline_huge_volume_lower_shadow"][index] = (
            deep_base and long_lower_shadow
        )
        events["deep_decline_huge_volume"][index] = huge
        events["deep_decline_huge_volume_strong"][index] = huge and strong_close
        events["deep_decline_huge_volume_weak"][index] = huge and weak_close
        events["deep_decline_huge_volume_lower_shadow"][index] = (
            huge and long_lower_shadow
        )

        # Confirmation is a separate, later signal: within five trading days
        # after a deep-state bar, price crosses the active pair's fast MA on a
        # bullish, high-location close.  Controls have the same reclaim after a
        # deep state but no preceding huge-volume event.
        reclaim_fast = (
            recent_flag(
                eligibility["deep_decline_huge_volume"],
                index,
                CONFIRMATION_WINDOW,
            )
            and bars[index - 1].close <= previous_fast
            and bar.close > fast
            and bar.close > bar.open
            and close_location >= 0.65
        )
        eligibility["deep_decline_huge_volume_reclaim_fast"][index] = reclaim_fast
        events["deep_decline_huge_volume_reclaim_fast"][index] = (
            reclaim_fast
            and recent_flag(
                events["deep_decline_huge_volume"],
                index,
                CONFIRMATION_WINDOW,
            )
        )

        # Matching features are state variables, not event-defining volume or
        # candlestick-shape variables.  drawdown60 makes deep-state controls
        # comparable while distance/ribbon preserve the active MA context.
        features[index] = turn.FeaturePoint(
            prior_return=drawdown60,
            distance_fast=bar.close / fast - 1,
            ribbon_spread=fast / slow - 1,
            volatility20=volatility20,
        )

    return {
        "events": events,
        "eligibility": eligibility,
        "features": features,
    }


def validate_source(
    baseline: dict[str, Any], cache_dir: Path
) -> tuple[dict[str, list[Any]], list[str], list[str]]:
    metadata = baseline["metadata"]
    bars_by_symbol: dict[str, list[Any]] = {}
    mismatches: list[str] = []
    missing: list[str] = []
    for symbol, expected in sorted(baseline["universe"].items()):
        path = base.cache_path(cache_dir, symbol, metadata)
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
    return bars_by_symbol, mismatches, missing


def run(args: argparse.Namespace) -> dict[str, Any]:
    baseline = json.loads(args.baseline.read_text(encoding="utf-8"))
    metadata = baseline["metadata"]
    bars_by_symbol, mismatches, missing = validate_source(baseline, args.cache_dir)
    if missing or mismatches:
        raise RuntimeError(
            f"source validation failed: missing={missing[:5]} mismatches={mismatches[:5]}"
        )

    values_by_symbol = {
        symbol: base.indicators(bars) for symbol, bars in bars_by_symbol.items()
    }
    states_by_pair: dict[str, dict[str, dict[str, Any]]] = {}
    for pair in turn.PAIR_CONFIGS:
        states_by_pair[pair.key] = {
            symbol: build_special_state(bars, values_by_symbol[symbol], pair)
            for symbol, bars in bars_by_symbol.items()
        }
        print(f"built special state: {pair.key}", file=sys.stderr, flush=True)

    # Reuse the audited outcome, cooldown, same-date matching and clustered
    # bootstrap machinery, but point it at this study's frozen event metadata.
    turn.EVENT_META = EVENT_META
    turn.BOOTSTRAP_ITERATIONS = args.bootstrap_iterations
    contexts = turn.contexts_from_baseline(baseline, set(bars_by_symbol))
    study: dict[str, Any] = {}
    for pair in turn.PAIR_CONFIGS:
        pair_contexts: dict[str, Any] = {}
        for context in contexts:
            pair_contexts[context.key] = {
                "label": context.label,
                "start": context.start.isoformat(),
                "end": context.end.isoformat(),
                "symbols": len(context.all_symbols),
                "events": {
                    event_key: turn.context_summary(
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

    result = {
        "metadata": {
            "study_version": STUDY_VERSION,
            "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
            "purpose": "supplementary non-trading study of two untested turning markers",
            "script_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            "turning_study_script_sha256": hashlib.sha256(TURN_PATH.read_bytes()).hexdigest(),
            "source_artifact": str(args.baseline),
            "source_artifact_sha256": hashlib.sha256(args.baseline.read_bytes()).hexdigest(),
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
            "exploratory_multiple_comparisons": True,
            "bootstrap_iterations": args.bootstrap_iterations,
            "matching": (
                "up to three nearest same-date, other-symbol controls in the same "
                "causal setup state but without the defining doji/volume event"
            ),
            "limitations": [
                "This is a locked retrospective supplement on previously inspected data, not a pristine untouched holdout.",
                "The causal deep-decline definition is not proof that the event bar is a market bottom.",
                "Multiple predeclared variants are reported without selecting a winner; isolated significance is insufficient for launch.",
                "Point-in-time cohorts reduce but do not eliminate index-selection and survivorship bias.",
                "Matched controls reduce broad market and state confounding but do not prove causality.",
                "Historical conditional frequencies cannot guarantee future behavior.",
            ],
        },
        "source_validation": {
            "symbols": len(bars_by_symbol),
            "rows": sum(len(bars) for bars in bars_by_symbol.values()),
            "manifest_mismatches": mismatches,
            "missing_cache": missing,
        },
        "event_definitions": {
            "quiet_doji_pullback": {
                "doji": "abs(Close - Open) / (High - Low) <= 0.20; zero-range bars excluded",
                "current_volume": "Volume / VMA20 <= 0.70",
                "broad_volume": "VMA5 / VMA20 <= 0.85",
                "isolated_control": "same quiet pullback state without a doji",
                "combined_control": "same MA/pullback state without the full quiet-doji event",
            },
            "deep_decline_huge_volume": {
                "deep_drawdown": "Close / prior 60-trading-day High - 1 <= -0.25",
                "depressed_state": "at least 10 of prior 20 closes below MA20 and current Close <= MA20",
                "huge_volume": "Volume / VMA20 >= 2.50 (VMA20 includes current bar)",
                "strong_close": "Close > Open and close location >= 0.70",
                "weak_close": "close location <= 0.35",
                "long_lower_shadow": "lower shadow / range >= 0.45 and close location >= 0.55",
                "reclaim_fast": (
                    "within 5 bars after deep state, prior Close <= prior active fast MA, "
                    "then bullish Close > active fast MA with close location >= 0.65; "
                    "active fast MA is MA5 in short mode and MA20 in mid mode"
                ),
            },
            "pairs": {
                pair.key: dataclasses.asdict(pair) for pair in turn.PAIR_CONFIGS
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
    parser.add_argument("--bootstrap-iterations", type=int, default=2_000)
    parser.add_argument("--output", type=Path, required=True)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    if args.bootstrap_iterations < 100:
        raise ValueError("bootstrap iterations must be at least 100")
    result = run(args)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"wrote {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
