#!/usr/bin/env python3
"""Aggregate annual point-in-time chan.py validation slices.

Each input is produced by chan-signal-stability.py with the matching annual
cohort and an inclusive year-end cutoff.  The aggregate deliberately keeps the
annual folds visible; weighted pooled figures are descriptive, not a substitute
for cross-year stability.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
from typing import Any


YEARS = (2021, 2022, 2023, 2024, 2025, 2026)
STAGES = ("first_seen", "underlying_bi_sure", "marker_frozen")
HORIZONS = ("5", "10", "20")


def weighted(rows: list[dict[str, Any]], key: str) -> float | None:
    eligible = [row for row in rows if row.get(key) is not None and row["signals"]]
    total = sum(row["signals"] for row in eligible)
    if not total:
        return None
    return sum(row[key] * row["signals"] for row in eligible) / total


def pooled(rows: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "signals": sum(row["signals"] for row in rows),
        "weighted_direction_correct_rate": weighted(
            rows, "direction_correct_rate"
        ),
        "weighted_mean_signed_return": weighted(rows, "mean_signed_return"),
        "weighted_net_buy_positive_rate": weighted(
            rows, "positive_rate_after_costs_if_buy"
        ),
        "weighted_mean_net_buy_return": weighted(rows, "mean_net_buy_return"),
    }


def compact_metric(row: dict[str, Any]) -> dict[str, Any]:
    cooldown = row.get("non_overlapping_horizon_cooldown", {})
    return {
        "signals": row.get("signals"),
        "symbols": row.get("symbols"),
        "direction_correct_rate": row.get("direction_correct_rate"),
        "mean_signed_return": row.get("mean_signed_return"),
        "positive_rate_after_costs_if_buy": row.get(
            "positive_rate_after_costs_if_buy",
            row.get("buy_positive_rate_after_costs"),
        ),
        "cluster_bootstrap": row.get("cluster_bootstrap"),
        "non_overlapping_horizon_cooldown": {
            "signals": cooldown.get("signals"),
            "symbols": cooldown.get("symbols"),
            "direction_correct_rate": cooldown.get("direction_correct_rate"),
            "mean_signed_return": cooldown.get("mean_signed_return"),
            "net_buy_positive_rate": cooldown.get("net_buy_positive_rate"),
            "mean_net_buy_return": cooldown.get("mean_net_buy_return"),
            "cluster_bootstrap": cooldown.get("cluster_bootstrap"),
        },
    }


def run(input_dir: Path) -> dict[str, Any]:
    inputs: dict[int, dict[str, Any]] = {}
    hashes: dict[str, str] = {}
    for year in YEARS:
        path = input_dir / f"chan-signal-stability-{year}.json"
        raw = path.read_bytes()
        hashes[str(year)] = hashlib.sha256(raw).hexdigest()
        inputs[year] = json.loads(raw)

    configurations = sorted(
        set.intersection(
            *(set(item["configurations"]) for item in inputs.values())
        )
    )
    result: dict[str, Any] = {
        "metadata": {
            "generated_at": inputs[YEARS[-1]]["metadata"]["generated_at"],
            "purpose": "annual point-in-time stability audit",
            "years": list(YEARS),
            "engine": inputs[YEARS[0]]["metadata"]["engine"],
            "engine_commit": inputs[YEARS[0]]["metadata"]["engine_commit"],
            "provider": inputs[YEARS[0]]["metadata"]["provider"],
            "adjustment": inputs[YEARS[0]]["metadata"]["adjustment"],
            "annual_input_sha256": hashes,
            "method": (
                "For each year, use that year's deterministic point-in-time "
                "CSI 300/CSI 500 cohort and only decisions inside the year."
            ),
            "limitations": inputs[YEARS[0]]["metadata"]["limitations"],
        },
        "cohorts": {},
        "configurations": {},
    }

    for year, item in inputs.items():
        result["cohorts"][str(year)] = {
            "snapshot": item["metadata"]["cohort_snapshot"],
            "analysis_end": item["metadata"]["analysis_end"],
            "symbols": item["metadata"]["symbols"],
            "unconditional_direction_baseline": item[
                "unconditional_direction_baseline"
            ],
        }

    for configuration in configurations:
        config_result: dict[str, Any] = {
            "overrides": inputs[YEARS[0]]["configurations"][configuration][
                "overrides"
            ],
            "annual_lifecycle": {},
            "stages": {},
        }
        for year, item in inputs.items():
            config_result["annual_lifecycle"][str(year)] = item[
                "configurations"
            ][configuration]["lifecycle"]

        for stage in STAGES:
            stage_result: dict[str, Any] = {}
            for horizon in HORIZONS:
                annual_overall: dict[str, Any] = {}
                labels: set[str] = set()
                for year, item in inputs.items():
                    source = item["configurations"][configuration]["outcomes"][
                        stage
                    ]
                    annual_overall[str(year)] = compact_metric(source[horizon])
                    labels.update(
                        source["by_side_and_type_non_exclusive"][horizon]
                    )

                by_type: dict[str, Any] = {}
                for label in sorted(labels):
                    annual: dict[str, Any] = {}
                    rows: list[dict[str, Any]] = []
                    cooldown_rows: list[dict[str, Any]] = []
                    years_above_raw_baseline = 0
                    for year, item in inputs.items():
                        source = item["configurations"][configuration][
                            "outcomes"
                        ][stage]["by_side_and_type_non_exclusive"][horizon]
                        if label not in source:
                            continue
                        row = source[label]
                        annual[str(year)] = compact_metric(row)
                        rows.append(row)
                        cooldown_rows.append(
                            {
                                **row["non_overlapping_horizon_cooldown"],
                                "positive_rate_after_costs_if_buy": row[
                                    "non_overlapping_horizon_cooldown"
                                ]["net_buy_positive_rate"],
                            }
                        )
                        side = label.split(":", 1)[0]
                        baseline_key = "positive_rate" if side == "buy" else "decline_rate"
                        baseline = item["unconditional_direction_baseline"][
                            horizon
                        ][baseline_key]
                        if (
                            row["direction_correct_rate"] is not None
                            and row["direction_correct_rate"] > baseline
                        ):
                            years_above_raw_baseline += 1
                    by_type[label] = {
                        "annual": annual,
                        "descriptive_pooled": pooled(rows),
                        "descriptive_pooled_non_overlapping_horizon_cooldown": pooled(
                            cooldown_rows
                        ),
                        "years_above_same_fold_raw_direction_baseline": years_above_raw_baseline,
                    }

                stage_result[horizon] = {
                    "annual_overall": annual_overall,
                    "by_side_and_type_non_exclusive": by_type,
                }
            config_result["stages"][stage] = stage_result
        result["configurations"][configuration] = config_result

    return round_floats(result)


def round_floats(value: Any) -> Any:
    if isinstance(value, float):
        return round(value, 8) if math.isfinite(value) else None
    if isinstance(value, dict):
        return {key: round_floats(item) for key, item in value.items()}
    if isinstance(value, list):
        return [round_floats(item) for item in value]
    return value


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input-dir", type=Path, default=Path("/tmp"))
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(
            "docs/research-data/chan-signal-walk-forward-2026-08-21.json"
        ),
    )
    args = parser.parse_args()
    result = run(args.input_dir)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(args.output)


if __name__ == "__main__":
    main()
