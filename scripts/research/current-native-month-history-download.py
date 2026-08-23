#!/usr/bin/env python3
"""Download current-listed native monthly qfq bars for the production audit.

The daily full-market cache is intentionally capped by Sina at about 1,900
rows, which is not enough for the product's 121-month warmup.  This companion
cache can use Tencent or Eastmoney native monthly series. The analyzer obtains
eligible-month liquidity from the raw daily cache, so adjusted monthly prices
are never used as the primary turnover filter.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import dataclasses
import datetime as dt
import gzip
import hashlib
import importlib.util
import json
import os
import sys
import urllib.parse
from pathlib import Path
from types import ModuleType
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
FROZEN_SCRIPT = ROOT / "scripts/research/full-market-turning-point-study.py"
DEFAULT_CACHE = Path("/tmp/hanai-current-production-turning-cache-v1/native-month")
DEFAULT_DB = Path.home() / ".hanai-investment-dsh/db/hanai.sqlite"
NATIVE_START = "1990-01-01"


def load_frozen_module() -> ModuleType:
    spec = importlib.util.spec_from_file_location("hanai_frozen_native_month", FROZEN_SCRIPT)
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
    parser.add_argument("--workers", type=int, default=32)
    parser.add_argument("--provider", choices=("eastmoney", "tencent"), default="tencent")
    parser.add_argument("--refresh", action="store_true")
    parser.add_argument("--max-symbols", type=int, default=None)
    parser.add_argument("--exchange", choices=("SH", "SZ", "BJ"), default=None)
    return parser.parse_args()


def cache_path(cache_dir: Path, security: Any) -> Path:
    return cache_dir / "bars" / f"{security.canonical.replace('.', '-')}.json.gz"


def fetch_series(frozen: ModuleType, security: Any, adjustment: str) -> dict[str, list[Any]]:
    symbol = frozen.tencent_symbol(security)
    param = f"{symbol},month,,{frozen.END},800,{adjustment}"
    # The legacy /fqkline/get endpoint intermittently returns HTTP 501 under
    # sustained research loads; /newfqkline/get has the same response schema.
    url = "https://web.ifzq.gtimg.cn/appstock/app/newfqkline/get?" + urllib.parse.urlencode(
        {"param": param}
    )
    envelope = json.loads(frozen.fetch_url_bytes(url, "https://gu.qq.com/").decode("utf-8"))
    stock = (envelope.get("data") or {}).get(symbol)
    if not isinstance(stock, dict):
        return {}
    key = f"{adjustment}month" if adjustment in {"qfq", "hfq"} else "month"
    rows = stock.get(key)
    result: dict[str, list[Any]] = {}
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, list) or len(row) < 6 or not isinstance(row[0], str):
            continue
        if NATIVE_START <= row[0] <= frozen.END:
            result[row[0]] = row
    return result


def fetch_eastmoney_month(frozen: ModuleType, security: Any) -> list[str]:
    params = {
        "secid": security.secid,
        "klt": "103",
        "fqt": "1",
        "beg": NATIVE_START.replace("-", ""),
        "end": frozen.END.replace("-", ""),
        "fields1": "f1,f2,f3,f4,f5,f6",
        "fields2": "f51,f52,f53,f54,f55,f56,f57",
    }
    query = urllib.parse.urlencode(params)
    seed = int(hashlib.sha256(security.canonical.encode()).hexdigest()[:8], 16)
    last_error: Exception | None = None
    for attempt in range(4):
        host_number = 1 + ((seed + attempt * 7) % 19)
        url = f"https://{host_number}.push2his.eastmoney.com/api/qt/stock/kline/get?{query}"
        try:
            envelope = json.loads(
                frozen.fetch_url_bytes(url, "https://quote.eastmoney.com/", attempts=1).decode("utf-8")
            )
            data = envelope.get("data") if isinstance(envelope, dict) else None
            rows = data.get("klines") if isinstance(data, dict) else None
            if envelope.get("rc") != 0 or not isinstance(rows, list):
                raise RuntimeError(f"empty/invalid Eastmoney response rc={envelope.get('rc')}")
            return [
                row
                for row in rows
                if isinstance(row, str) and NATIVE_START <= row.split(",", 1)[0] <= frozen.END
            ]
        except Exception as error:  # pragma: no cover - network behavior
            last_error = error
    raise RuntimeError(f"Eastmoney native month failed: {last_error!r}")


def fetch_one(
    frozen: ModuleType, security: Any, cache_dir: Path, refresh: bool, provider: str
) -> dict[str, Any]:
    path = cache_path(cache_dir, security)
    if path.exists() and not refresh:
        return {"symbol": security.canonical, "status": "cached", "bytes": path.stat().st_size}
    try:
        if provider == "eastmoney":
            lines = fetch_eastmoney_month(frozen, security)
            provider_label = "Eastmoney native monthly qfq"
            amount_semantics = "vendor-reported period amount"
        else:
            if security.exchange == "BJ":
                raise RuntimeError("Tencent native monthly endpoint does not cover BSE securities")
            adjusted = fetch_series(frozen, security, "qfq")
            lines = []
            for date in sorted(adjusted):
                adjusted_row = adjusted[date]
                try:
                    open_price, close, high, low, volume = map(float, adjusted_row[1:6])
                except (IndexError, TypeError, ValueError):
                    continue
                if min(open_price, close, high, low, volume) <= 0:
                    continue
                # The analyzer replaces this with raw daily mean amount on all
                # eligible months; this positive placeholder only preserves the
                # common cache schema before that merge.
                amount_proxy = close * volume * 100
                lines.append(
                    f"{date},{open_price:.6f},{close:.6f},{high:.6f},{low:.6f},"
                    f"{volume:.6f},{amount_proxy:.2f}"
                )
            provider_label = "Tencent native monthly fqkline"
            amount_semantics = "adjusted close * volume placeholder; analyzer replaces with daily raw-amount mean"
        if not lines:
            raise RuntimeError("empty Tencent native-month intersection")
        payload = {
            "canonical": security.canonical,
            "secid": security.secid,
            "name": security.name,
            "provider": provider_label,
            "fqt": "qfq",
            "amount_semantics": amount_semantics,
            "fields": "date,open,close,high,low,volume,amount",
            "klines": lines,
        }
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(path.suffix + f".{os.getpid()}.tmp")
        with gzip.open(temporary, "wt", encoding="utf-8", compresslevel=5) as handle:
            json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
        temporary.replace(path)
        return {
            "symbol": security.canonical,
            "status": "downloaded",
            "rows": len(lines),
            "bytes": path.stat().st_size,
            "provider": payload["provider"],
        }
    except Exception as error:  # pragma: no cover - network behavior
        return {"symbol": security.canonical, "status": "failed", "error": repr(error)}


def main() -> int:
    args = parse_args()
    if not 1 <= args.workers <= 64:
        raise ValueError("workers must be between 1 and 64")
    if args.max_symbols is not None and args.max_symbols <= 0:
        raise ValueError("--max-symbols must be a positive integer")
    frozen = load_frozen_module()
    frozen.force_ipv4()
    master = sorted(
        frozen.load_current_master(args.database).values(), key=lambda item: item.canonical
    )
    master_count = len(master)
    securities = master
    if args.exchange is not None:
        securities = [item for item in securities if item.exchange == args.exchange]
    if args.max_symbols is not None:
        securities = securities[: args.max_symbols]
        print("WARNING: diagnostic subset only", file=sys.stderr)
    results: list[dict[str, Any]] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = [
            executor.submit(fetch_one, frozen, security, args.cache_dir, args.refresh, args.provider)
            for security in securities
        ]
        for index, future in enumerate(concurrent.futures.as_completed(futures), 1):
            result = future.result()
            results.append(result)
            if index % 100 == 0 or result["status"] == "failed":
                counts = {
                    status: sum(item["status"] == status for item in results)
                    for status in ("downloaded", "cached", "failed")
                }
                print(f"native-month {index}/{len(futures)} {counts}", file=sys.stderr, flush=True)
    manifest = {
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "provider": f"{args.provider} native monthly qfq (existing cache files may retain their recorded provider)",
        "requested_start": NATIVE_START,
        "requested_end": frozen.END,
        "universe": len(securities),
        "security_master_total": master_count,
        "exchange_filter": args.exchange,
        "max_symbols": args.max_symbols,
        "diagnostic_subset": args.max_symbols is not None or args.exchange is not None,
        "securities": [dataclasses.asdict(item) for item in securities],
        "results": sorted(results, key=lambda item: item["symbol"]),
    }
    args.cache_dir.mkdir(parents=True, exist_ok=True)
    (args.cache_dir / "download-manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )
    failures = sum(item["status"] == "failed" for item in results)
    print(f"native-month failures={failures}", file=sys.stderr, flush=True)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
