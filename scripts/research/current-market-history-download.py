#!/usr/bin/env python3
"""Download the current-listed A-share history used by the production audit.

This wrapper deliberately reuses the frozen full-market downloader without
editing it (which would invalidate the SHA-256 recorded by its 2026-08-22
artifact).  The resulting universe is the current Hanai security master only;
it therefore complements, rather than replaces, the historical/delisted
coverage in the frozen full-market study.
"""

from __future__ import annotations

import argparse
import dataclasses
import datetime as dt
import gzip
import importlib.util
import json
import math
import sys
import urllib.parse
from pathlib import Path
from types import ModuleType


ROOT = Path(__file__).resolve().parents[2]
FROZEN_SCRIPT = ROOT / "scripts/research/full-market-turning-point-study.py"
DEFAULT_CACHE = Path("/tmp/hanai-current-production-turning-cache-v1")
DEFAULT_DB = Path.home() / ".hanai-investment-dsh/db/hanai.sqlite"


def load_frozen_module() -> ModuleType:
    spec = importlib.util.spec_from_file_location("hanai_frozen_full_market", FROZEN_SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load frozen research script: {FROZEN_SCRIPT}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache-dir", type=Path, default=DEFAULT_CACHE)
    parser.add_argument("--database", type=Path, default=DEFAULT_DB)
    parser.add_argument("--workers", type=int, default=16)
    parser.add_argument(
        "--provider", choices=("auto", "eastmoney", "tencent", "sina"), default="auto"
    )
    parser.add_argument("--refresh", action="store_true")
    parser.add_argument("--max-symbols", type=int, default=None)
    parser.add_argument("--exchange", choices=("SH", "SZ", "BJ"), default=None)
    parser.add_argument("--benchmark-only", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not 1 <= args.workers <= 64:
        raise ValueError("workers must be between 1 and 64")
    if args.max_symbols is not None and args.max_symbols <= 0:
        raise ValueError("--max-symbols must be a positive integer")
    frozen = load_frozen_module()
    if args.benchmark_only:
        benchmark = frozen.Security(
            canonical="sh.000300",
            secid="1.000300",
            code="000300",
            name="沪深300",
            exchange="SH",
            board="SH_MAIN",
            ipo_date=None,
            out_date=None,
            current=True,
            baostock_status=None,
        )
        frozen.force_ipv4()
        path = frozen.cache_path_for(args.cache_dir, benchmark)
        if path.exists() and not args.refresh:
            result = {"symbol": benchmark.canonical, "status": "cached", "bytes": path.stat().st_size}
        else:
            symbol = "sh000300"
            datalen = 1900
            callback = f"_{symbol}_240_{datalen}"
            url = (
                f"https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20{callback}=/"
                "CN_MarketDataService.getKLineData?"
                + urllib.parse.urlencode(
                    {"symbol": symbol, "scale": "240", "ma": "no", "datalen": str(datalen)}
                )
            )
            text = frozen.fetch_url_bytes(url, "https://finance.sina.com.cn/").decode(
                "utf-8", errors="replace"
            )
            left = text.find("=([")
            right = text.rfind(");")
            if left < 0 or right <= left:
                raise RuntimeError("invalid Sina benchmark JSONP response")
            rows = json.loads(text[left + 2 : right])
            lines: list[str] = []
            for row in rows if isinstance(rows, list) else []:
                if not isinstance(row, dict):
                    continue
                date = row.get("day")
                if not isinstance(date, str) or not (frozen.START <= date <= frozen.END):
                    continue
                try:
                    open_price = float(row["open"])
                    high = float(row["high"])
                    low = float(row["low"])
                    close = float(row["close"])
                    volume = float(row["volume"])
                except (KeyError, TypeError, ValueError):
                    continue
                if not all(math.isfinite(value) and value > 0 for value in (open_price, high, low, close, volume)):
                    continue
                lines.append(
                    f"{date},{open_price:.6f},{close:.6f},{high:.6f},{low:.6f},"
                    f"{volume:.6f},{close * volume:.2f}"
                )
            payload = {
                "canonical": benchmark.canonical,
                "name": benchmark.name,
                "provider": "Sina CN_MarketData raw index history",
                "fqt": "not applicable to index",
                "fields": "date,open,close,high,low,volume,amount_proxy",
                "klines": lines,
            }
            path.parent.mkdir(parents=True, exist_ok=True)
            with gzip.open(path, "wt", encoding="utf-8", compresslevel=5) as handle:
                json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
            result = {
                "symbol": benchmark.canonical,
                "status": "downloaded",
                "rows": len(lines),
                "bytes": path.stat().st_size,
                "provider": payload["provider"],
            }
        args.cache_dir.mkdir(parents=True, exist_ok=True)
        (args.cache_dir / "benchmark-manifest.json").write_text(
            json.dumps(
                {
                    "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
                    "benchmark": dataclasses.asdict(benchmark),
                    "result": result,
                },
                ensure_ascii=False,
                separators=(",", ":"),
            ),
            encoding="utf-8",
        )
        print(result, file=sys.stderr, flush=True)
        return 0 if result["status"] in {"downloaded", "cached"} else 1
    master = sorted(
        frozen.load_current_master(args.database).values(), key=lambda item: item.canonical
    )
    master_count = len(master)
    securities = master
    if args.exchange is not None:
        securities = [item for item in securities if item.exchange == args.exchange]
    if args.max_symbols is not None:
        securities = securities[: args.max_symbols]
        print(
            "WARNING: --max-symbols creates a diagnostic subset, not full current-market evidence",
            file=sys.stderr,
        )

    args.cache_dir.mkdir(parents=True, exist_ok=True)
    universe = {
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "requested_start": frozen.START,
        "requested_end": frozen.END,
        "scope": "current-listed A shares in the Hanai security master",
        "survivorship_warning": (
            "Delisted historical securities are intentionally absent; use the frozen full-market "
            "artifact for historical-universe evidence."
        ),
        "database": str(args.database),
        "frozen_downloader": str(FROZEN_SCRIPT.relative_to(ROOT)),
        "security_master_total": master_count,
        "exchange_filter": args.exchange,
        "diagnostic_subset": args.max_symbols is not None or args.exchange is not None,
        "runtime_note": "Requires the repository research Python dependencies (numpy, pandas, baostock).",
        "securities": [dataclasses.asdict(item) for item in securities],
    }
    (args.cache_dir / "current-universe.json").write_text(
        json.dumps(universe, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )
    print(f"current-listed universe={len(securities)}", file=sys.stderr, flush=True)
    manifest = frozen.download_all(
        securities, args.cache_dir, args.refresh, args.workers, args.provider
    )
    manifest.update(
        {
            "security_master_total": master_count,
            "exchange_filter": args.exchange,
            "max_symbols": args.max_symbols,
            "diagnostic_subset": args.max_symbols is not None or args.exchange is not None,
        }
    )
    (args.cache_dir / "download-manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )
    failures = sum(item["status"] == "failed" for item in manifest["results"])
    print(f"failures={failures}", file=sys.stderr, flush=True)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
