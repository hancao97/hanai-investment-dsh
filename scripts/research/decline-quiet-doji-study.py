#!/usr/bin/env python3
"""Causal event study for a quiet doji after consecutive declines.

This is separate from the rising-ribbon pullback doji study.  The signal is
known at the doji close, outcomes start at the next open, and controls share the
same completed decline state without the defining quiet-doji event.
"""

from __future__ import annotations

import argparse
import dataclasses
import datetime as dt
import hashlib
import importlib.util
import json
import sys
from pathlib import Path
from typing import Any, Sequence


TURN_PATH = Path(__file__).with_name("ma-volume-turning-point-study.py")
TURN_SPEC = importlib.util.spec_from_file_location("decline_doji_turn_base", TURN_PATH)
if TURN_SPEC is None or TURN_SPEC.loader is None:  # pragma: no cover
    raise RuntimeError(f"cannot import {TURN_PATH}")
turn = importlib.util.module_from_spec(TURN_SPEC)
sys.modules[TURN_SPEC.name] = turn
TURN_SPEC.loader.exec_module(turn)
base = turn.base


STUDY_VERSION = "DECLINE_QUIET_DOJI_V0"
DOJI_BODY_RANGE_RATIO = 0.20
QUIET_VOLUME_RATIO = 0.70
STRICT_THREE_DECLINE = -0.03
FOUR_OF_FIVE_DECLINE = -0.05

PAIR = turn.PairConfig(
    key="decline_quiet_doji",
    label="连续下跌后缩量十字星",
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
)

EVENT_META: dict[str, dict[str, str | None]] = {
    "strict_three_quiet_doji_combined": {
        "label": "连续3跌后缩量十字星（对照连续下跌）",
        "side": "up",
        "product_semantics": "反弹观察候选",
    },
    "strict_three_quiet_doji_isolated": {
        "label": "连续3跌后缩量十字星（对照同样缩量但非十字星）",
        "side": "up",
        "product_semantics": "十字星增量",
    },
    "four_of_five_quiet_doji_combined": {
        "label": "5日4跌后缩量十字星（对照连续下跌）",
        "side": "up",
        "product_semantics": "较深回撤反弹观察候选",
    },
    "four_of_five_quiet_doji_isolated": {
        "label": "5日4跌后缩量十字星（对照同样缩量但非十字星）",
        "side": "up",
        "product_semantics": "十字星增量",
    },
}


def build_state(
    bars: Sequence[Any], values: dict[str, list[float | None]]
) -> dict[str, Any]:
    length = len(bars)
    events = {key: [False] * length for key in EVENT_META}
    eligibility = {key: [False] * length for key in EVENT_META}
    features: list[Any | None] = [None] * length
    volatilities = turn.rolling_volatility(bars)

    for index in range(121, length):
        ma20 = values["ma20"][index]
        ma60 = values["ma60"][index]
        vol20 = values["vol20"][index]
        volatility20 = volatilities[index]
        if not base.finite(ma20, ma60, vol20, volatility20):
            continue
        assert ma20 is not None and ma60 is not None and vol20 is not None
        assert volatility20 is not None
        if min(ma20, ma60, vol20) <= 0:
            continue

        bar = bars[index]
        width = bar.high - bar.low
        doji = width > 0 and abs(bar.close - bar.open) / width <= DOJI_BODY_RANGE_RATIO
        quiet = bar.volume / vol20 <= QUIET_VOLUME_RATIO

        strict_three = (
            all(
                bars[position].close < bars[position - 1].close
                for position in range(index - 3, index)
            )
            and bars[index - 1].close / bars[index - 4].close - 1
            <= STRICT_THREE_DECLINE
        )
        down_days = sum(
            bars[position].close < bars[position - 1].close
            for position in range(index - 5, index)
        )
        four_of_five = (
            down_days >= 4
            and bars[index - 1].close / bars[index - 6].close - 1
            <= FOUR_OF_FIVE_DECLINE
        )

        strict_event = strict_three and quiet and doji
        broad_event = four_of_five and quiet and doji
        events["strict_three_quiet_doji_combined"][index] = strict_event
        events["strict_three_quiet_doji_isolated"][index] = strict_event
        events["four_of_five_quiet_doji_combined"][index] = broad_event
        events["four_of_five_quiet_doji_isolated"][index] = broad_event
        eligibility["strict_three_quiet_doji_combined"][index] = strict_three
        eligibility["strict_three_quiet_doji_isolated"][index] = strict_three and quiet
        eligibility["four_of_five_quiet_doji_combined"][index] = four_of_five
        eligibility["four_of_five_quiet_doji_isolated"][index] = (
            four_of_five and quiet
        )

        prior_five_return = bars[index - 1].close / bars[index - 6].close - 1
        features[index] = turn.FeaturePoint(
            prior_return=prior_five_return,
            distance_fast=bar.close / ma20 - 1,
            ribbon_spread=ma20 / ma60 - 1,
            volatility20=volatility20,
        )

    return {"events": events, "eligibility": eligibility, "features": features}


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
    states_by_pair = {
        PAIR.key: {
            symbol: build_state(bars, values_by_symbol[symbol])
            for symbol, bars in bars_by_symbol.items()
        }
    }
    print("built state: decline quiet doji", file=sys.stderr, flush=True)

    turn.EVENT_META = EVENT_META
    turn.BOOTSTRAP_ITERATIONS = args.bootstrap_iterations
    contexts = turn.contexts_from_baseline(baseline, set(bars_by_symbol))
    contexts_result: dict[str, Any] = {}
    for context in contexts:
        contexts_result[context.key] = {
            "label": context.label,
            "start": context.start.isoformat(),
            "end": context.end.isoformat(),
            "symbols": len(context.all_symbols),
            "events": {
                event_key: turn.context_summary(
                    context,
                    PAIR,
                    event_key,
                    bars_by_symbol,
                    states_by_pair,
                )
                for event_key in EVENT_META
            },
        }
        print(f"summarized: {context.key}", file=sys.stderr, flush=True)

    result = {
        "metadata": {
            "study_version": STUDY_VERSION,
            "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
            "purpose": "supplementary non-trading study of a quiet doji after consecutive declines",
            "script_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            "turning_study_script_sha256": hashlib.sha256(TURN_PATH.read_bytes()).hexdigest(),
            "source_artifact": str(args.baseline),
            "source_artifact_sha256": hashlib.sha256(args.baseline.read_bytes()).hexdigest(),
            "provider": metadata["provider"],
            "adjustment": metadata["adjustment"],
            "frequency": "daily",
            "requested_start": metadata["requested_start"],
            "requested_end": metadata["requested_end"],
            "outcome_clock": "signal known at doji close; outcome starts at next open",
            "event_grid_frozen_before_evaluation": True,
            "no_parameter_selection": True,
            "bootstrap_iterations": args.bootstrap_iterations,
            "matching": "up to three nearest same-date controls in the same completed decline state",
        },
        "source_validation": {
            "symbols": len(bars_by_symbol),
            "rows": sum(len(bars) for bars in bars_by_symbol.values()),
            "manifest_mismatches": mismatches,
            "missing_cache": missing,
        },
        "event_definitions": {
            "doji": "abs(Close - Open) / (High - Low) <= 0.20; zero-range bars excluded",
            "quiet_volume": "Volume / VMA20 <= 0.70 (VMA20 includes signal bar)",
            "strict_three": "three completed consecutive lower closes before doji and cumulative decline <= -3%",
            "four_of_five": "at least four lower closes in five completed days before doji and cumulative decline <= -5%",
            "combined_control": "same decline state without the full quiet-doji event",
            "isolated_control": "same decline and quiet-volume state without a doji",
            "events": EVENT_META,
        },
        "pair": dataclasses.asdict(PAIR),
        "study": {PAIR.key: {"label": PAIR.label, "contexts": contexts_result}},
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
