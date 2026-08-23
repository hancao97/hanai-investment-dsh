#!/usr/bin/env python3
"""Full-market A-share turning-point event study.

This research-only program deliberately separates data acquisition from the
product runtime.  It builds a historical Shanghai/Shenzhen stock universe from
BaoStock's security master, merges the current Beijing Stock Exchange master
from Hanai SQLite, downloads back-adjusted Eastmoney daily OHLCV, freezes a
small family of causal turning-point definitions, and evaluates signals known
at the close from the next tradable open.

The output is an event-study artifact, not an execution promise.  In
particular, Eastmoney K-line history does not expose point-in-time ST names or
raw adjustment factors.  The artifact records this limitation and never calls
an observed conditional frequency a guaranteed win rate.

Research environment (kept outside the repository):

    python3 -m venv /tmp/hanai-full-market-research
    /tmp/hanai-full-market-research/bin/pip install baostock numpy
    /tmp/hanai-full-market-research/bin/python \
      scripts/research/full-market-turning-point-study.py all
"""

from __future__ import annotations

import argparse
import concurrent.futures
import dataclasses
import datetime as dt
import gzip
import hashlib
import json
import math
import os
import random
import socket
import sqlite3
import ssl
import statistics
import sys
import threading
import time
import urllib.parse
import urllib.request
from collections import defaultdict, deque
from pathlib import Path
from typing import Any, Iterable, Iterator, Mapping, Sequence

import numpy as np


STUDY_VERSION = "FULL_A_TURNING_V0"
START = "2014-01-01"
END = "2026-08-20"
HORIZONS = (3, 5, 10, 20)
PRIMARY_LIQUIDITY = 30_000_000.0
SENSITIVITY_LIQUIDITY = 50_000_000.0
MIN_LISTED_BARS = 120
BUY_COMMISSION = 0.0003
SELL_COMMISSION = 0.0003
TRANSFER_FEE = 0.00001
SELL_STAMP_DUTY = 0.0005
SLIPPAGE = 0.001
BUY_COST = BUY_COMMISSION + TRANSFER_FEE
SELL_COST = SELL_COMMISSION + TRANSFER_FEE + SELL_STAMP_DUTY
SOURCE_FIELDS = "f51,f52,f53,f54,f55,f56,f57"
DEFAULT_CACHE = Path("/tmp/hanai-full-market-turning-cache-v0")
DEFAULT_DB = Path.home() / ".hanai-investment-dsh/db/hanai.sqlite"
DEFAULT_PRIOR = Path("docs/research-data/kline-signal-backtest-2026-08-21.json")
DEFAULT_OUTPUT = Path("docs/research-data/full-market-turning-point-study-2026-08-22.json")


@dataclasses.dataclass(frozen=True)
class Security:
    canonical: str
    secid: str
    code: str
    name: str
    exchange: str
    board: str
    ipo_date: str | None
    out_date: str | None
    current: bool
    baostock_status: str | None


@dataclasses.dataclass(frozen=True)
class SignalDefinition:
    key: str
    label: str
    side: str
    family: str
    stage: str
    primary_horizon: int
    cooldown: int
    priority: str
    rule: str


@dataclasses.dataclass
class Features:
    dates: list[str]
    open: np.ndarray
    close: np.ndarray
    high: np.ndarray
    low: np.ndarray
    volume: np.ndarray
    amount: np.ndarray
    ma5: np.ndarray
    ma10: np.ndarray
    ma20: np.ndarray
    ma60: np.ndarray
    vma20_prior: np.ndarray
    vma60_prior: np.ndarray
    amount20_median_prior: np.ndarray
    atr20_prior: np.ndarray
    hh20_prior: np.ndarray
    ll20_prior: np.ndarray
    hh60_prior: np.ndarray
    dd60: np.ndarray
    ret20_prior: np.ndarray
    below20: np.ndarray
    clv: np.ndarray
    lower_shadow: np.ndarray
    upper_shadow: np.ndarray
    body: np.ndarray
    true_range: np.ndarray
    volume_ratio: np.ndarray


@dataclasses.dataclass(frozen=True)
class Event:
    signal: str
    side: str
    family: str
    symbol: str
    board: str
    fold: str
    signal_date: str
    anchor_date: str
    entry_date: str
    exit_date: str
    horizon: int
    raw_return: float
    net_return: float
    direction_hit: bool
    context_key: str
    coarse_context_key: str
    volume_layer: str | None
    entry_gap: float
    liquidity: float


SIGNALS: tuple[SignalDefinition, ...] = (
    SignalDefinition(
        "low_bullish_outside", "低位破低反包", "buy", "low_bullish_outside",
        "confirmed", 20, 20, "P0",
        "DD60<=-15%; prior-10d<=-10%; Below20>=10; lower low + higher high; "
        "close above prior high; bullish; CLV>=.75; TR/ATR20>=1.2; VR20>=1.2",
    ),
    SignalDefinition(
        "hammer_spring_raw", "金针探底观察", "buy", "hammer_spring", "anchor", 20, 20, "P1",
        "DD60<=-20%; Below20>=10; low breaks LL20 and close reclaims it; "
        "lower shadow>=.50; CLV>=.65; body<=.35; TR/ATR20>=.8",
    ),
    SignalDefinition(
        "hammer_spring_confirmed", "金针探底确认", "buy", "hammer_spring", "confirmed", 20, 20, "P1",
        "Within 1-3 bars after hammer: first close above anchor high and MA5, CLV>=.55; "
        "invalidated by low below anchor low minus .25 anchor ATR",
    ),
    SignalDefinition(
        "bottom_huge_strong_close", "深跌巨量强收", "buy", "bottom_huge", "confirmed", 20, 20, "benchmark",
        "DD60<=-25%; Below20>=10; close<=MA20; VR20>=2.5; bullish; CLV>=.70",
    ),
    SignalDefinition(
        "capitulation_anchor", "底部巨量恐慌观察", "buy", "capitulation_retest", "anchor", 20, 20, "P1",
        "DD60<=-20%; Below20>=10; VR20>=2.5; bearish; CLV<=.30; body>=.50; TR/ATR20>=1.5",
    ),
    SignalDefinition(
        "capitulation_retest_confirmed", "巨量后缩量不破转强", "buy", "capitulation_retest", "confirmed", 20, 20, "P1",
        "2-7 bars after capitulation: lows hold within 2%; at least one VR<=.70; then bullish "
        "close above prior high/anchor midpoint with CLV>=.65 and 1<=VR<=3.5",
    ),
    SignalDefinition(
        "extreme_dry_stabilize_raw", "三日极度缩量企稳", "buy", "extreme_dry", "anchor", 20, 20, "P2",
        "DD60<=-15%; Below20>=10; median last-3 volume/VMA60<=.45; three-day low "
        "holds prior floor within 2%; three-day close change within 3%",
    ),
    SignalDefinition(
        "extreme_dry_stabilize_confirmed", "极缩量后脱离平台", "buy", "extreme_dry", "confirmed", 20, 20, "P2",
        "Within 1-3 bars: first close above anchor three-day high and MA5; bullish; CLV>=.65; "
        "1<=VR<=3.5; invalid if platform low breaks by 2%",
    ),
    SignalDefinition(
        "double_bottom_volume_divergence_raw", "双底量能背离观察", "buy", "double_bottom", "anchor", 20, 20, "P2",
        "Compare current low with the unique earliest trough 40-10 bars ago; lows within 3%; "
        "current normalized volume <=70% of first trough; lower shadow>=.25",
    ),
    SignalDefinition(
        "double_bottom_volume_divergence_confirmed", "双底放量破颈线", "buy", "double_bottom", "confirmed", 20, 20, "P2",
        "Within 1-5 bars: first close above frozen neckline; CLV>=.65; VR>=1.2; "
        "invalid if current trough breaks by 3%",
    ),
    SignalDefinition(
        "huge_upper_rejection_raw", "高位巨量长上影", "sell", "huge_upper_rejection", "anchor", 5, 10, "P0",
        "Prior Ret20>=15%; MA5>MA10 and MA10 rising; prior close>MA5; new HH20; "
        "VR20>=2.5; upper shadow>=.55; CLV<=.35; TR/ATR20>=1",
    ),
    SignalDefinition(
        "huge_upper_rejection_confirmed", "巨量长上影跌破确认", "sell", "huge_upper_rejection", "confirmed", 5, 10, "P0",
        "Within 1-3 bars after upper rejection: first close below anchor low",
    ),
    SignalDefinition(
        "failed_breakout_raw", "放量假突破观察", "sell", "failed_breakout", "anchor", 10, 10, "P1",
        "Prior Ret20>=10%; MA5>MA10; high>=1.005*HH20 but close<=HH20; VR>=1.5; "
        "CLV<=.45; upper shadow>=.25; excludes strict huge-upper family",
    ),
    SignalDefinition(
        "failed_breakout_confirmed", "假突破跌破确认", "sell", "failed_breakout", "confirmed", 10, 10, "P1",
        "Within 1-2 bars after failed breakout: first close below anchor low",
    ),
    SignalDefinition(
        "double_top_volume_divergence_raw", "双顶量能背离观察", "sell", "double_top", "anchor", 20, 20, "P2",
        "Compare current high with unique earliest peak 40-10 bars ago; highs within -2%/+5%; "
        "current normalized volume <=70% of first peak; upper shadow>=.20; CLV<=.55",
    ),
    SignalDefinition(
        "double_top_volume_divergence_confirmed", "双顶放量破颈线", "sell", "double_top", "confirmed", 20, 20, "P2",
        "Within 1-5 bars: first close below frozen neckline; CLV<=.35; VR>=1.2; "
        "invalid if current peak is exceeded by 5%",
    ),
)
SIGNAL_BY_KEY = {item.key: item for item in SIGNALS}


def board_for(exchange: str, code: str) -> str:
    if exchange == "BJ":
        return "BSE"
    if exchange == "SH" and code.startswith(("688", "689")):
        return "STAR"
    if exchange == "SZ" and code.startswith(("300", "301", "302")):
        return "CHINEXT"
    return "SH_MAIN" if exchange == "SH" else "SZ_MAIN"


def is_a_share(exchange: str, code: str) -> bool:
    if exchange == "SH":
        return code.startswith(("600", "601", "603", "605", "688", "689"))
    if exchange == "SZ":
        return code.startswith(("000", "001", "002", "003", "300", "301", "302"))
    if exchange == "BJ":
        return code.startswith(("4", "8", "9"))
    return False


def canonical_for(exchange: str, code: str) -> str:
    return f"{exchange.lower()}.{code}"


def secid_for(exchange: str, code: str) -> str:
    return f"{1 if exchange == 'SH' else 0}.{code}"


def load_current_master(database: Path) -> dict[str, Security]:
    if not database.exists():
        raise FileNotFoundError(f"Hanai security master not found: {database}")
    connection = sqlite3.connect(f"file:{database}?mode=ro", uri=True)
    try:
        rows = connection.execute(
            "SELECT code,name,exchange FROM security_master ORDER BY exchange,code"
        ).fetchall()
    finally:
        connection.close()
    securities: dict[str, Security] = {}
    for code, name, exchange in rows:
        exchange = str(exchange)
        code = str(code)
        if not is_a_share(exchange, code):
            continue
        canonical = canonical_for(exchange, code)
        securities[canonical] = Security(
            canonical=canonical,
            secid=secid_for(exchange, code),
            code=code,
            name=str(name),
            exchange=exchange,
            board=board_for(exchange, code),
            ipo_date=None,
            out_date=None,
            current=True,
            baostock_status=None,
        )
    return securities


def query_baostock_basic() -> list[list[str]]:
    try:
        import baostock as bs
    except ImportError as error:  # pragma: no cover - operator dependency
        raise SystemExit("Missing research dependency: pip install baostock") from error
    login = bs.login()
    if login.error_code != "0":
        raise RuntimeError(f"BaoStock login: {login.error_code} {login.error_msg}")
    try:
        result = bs.query_stock_basic()
        rows: list[list[str]] = []
        while result.error_code == "0" and result.next():
            rows.append(result.get_row_data())
        if result.error_code != "0":
            raise RuntimeError(
                f"BaoStock query_stock_basic: {result.error_code} {result.error_msg}"
            )
        return rows
    finally:
        bs.logout()


def build_universe(database: Path, universe_path: Path, refresh: bool) -> list[Security]:
    if universe_path.exists() and not refresh:
        payload = json.loads(universe_path.read_text(encoding="utf-8"))
        return [Security(**row) for row in payload["securities"]]

    current = load_current_master(database)
    merged = dict(current)
    for row in query_baostock_basic():
        if len(row) < 6:
            continue
        raw_code, name, ipo_date, out_date, security_type, status = row[:6]
        if security_type != "1" or "." not in raw_code:
            continue
        prefix, code = raw_code.split(".", 1)
        exchange = prefix.upper()
        if exchange not in {"SH", "SZ"} or not is_a_share(exchange, code):
            continue
        if ipo_date and ipo_date > END:
            continue
        if out_date and out_date < START:
            continue
        canonical = canonical_for(exchange, code)
        existing = merged.get(canonical)
        merged[canonical] = Security(
            canonical=canonical,
            secid=secid_for(exchange, code),
            code=code,
            name=existing.name if existing is not None else name,
            exchange=exchange,
            board=board_for(exchange, code),
            ipo_date=ipo_date or None,
            out_date=out_date or None,
            current=existing is not None,
            baostock_status=status or None,
        )

    securities = sorted(merged.values(), key=lambda item: item.canonical)
    universe_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "start": START,
        "end": END,
        "sources": ["BaoStock query_stock_basic", str(database)],
        "securities": [dataclasses.asdict(item) for item in securities],
    }
    universe_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    return securities


_ORIGINAL_GETADDRINFO = socket.getaddrinfo
_REQUEST_LOCK = threading.Lock()
_LAST_REQUEST_AT = 0.0
_MIN_REQUEST_INTERVAL = 0.09


def force_ipv4() -> None:
    """Eastmoney currently closes IPv6 history sockets; keep research on IPv4."""

    def ipv4_getaddrinfo(*args: Any, **kwargs: Any) -> list[Any]:
        return [
            item
            for item in _ORIGINAL_GETADDRINFO(*args, **kwargs)
            if item[0] == socket.AF_INET
        ]

    socket.getaddrinfo = ipv4_getaddrinfo  # type: ignore[assignment]


def throttle_request() -> None:
    global _LAST_REQUEST_AT
    with _REQUEST_LOCK:
        wait = _LAST_REQUEST_AT + _MIN_REQUEST_INTERVAL - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        _LAST_REQUEST_AT = time.monotonic()


def cache_path_for(cache_dir: Path, security: Security) -> Path:
    return cache_dir / "bars" / f"{security.canonical.replace('.', '-')}.json.gz"


def fetch_one_eastmoney(security: Security, cache_dir: Path, refresh: bool) -> dict[str, Any]:
    path = cache_path_for(cache_dir, security)
    if path.exists() and not refresh:
        return {"symbol": security.canonical, "status": "cached", "bytes": path.stat().st_size}
    params = {
        "secid": security.secid,
        "klt": "101",
        "fqt": "2",  # back-adjusted; positive historical prices and total-return continuity
        "beg": START.replace("-", ""),
        "end": END.replace("-", ""),
        "fields1": "f1,f2,f3,f4,f5,f6",
        "fields2": SOURCE_FIELDS,
    }
    query = urllib.parse.urlencode(params)
    last_error: Exception | None = None
    seed = int(hashlib.sha256(security.canonical.encode()).hexdigest()[:8], 16)
    for attempt in range(4):
        host_number = 1 + ((seed + attempt * 7) % 19)
        url = f"https://{host_number}.push2his.eastmoney.com/api/qt/stock/kline/get?{query}"
        request = urllib.request.Request(
            url,
            headers={
                "User-Agent": "Mozilla/5.0 Hanai-Worth-Research/1.0",
                "Referer": "https://quote.eastmoney.com/",
                "Accept": "application/json,text/plain,*/*",
            },
        )
        try:
            context = ssl._create_unverified_context()  # local CA bundle is unavailable
            with urllib.request.urlopen(request, timeout=25, context=context) as response:
                envelope = json.load(response)
            data = envelope.get("data") if isinstance(envelope, dict) else None
            lines = data.get("klines") if isinstance(data, dict) else None
            if envelope.get("rc") != 0 or not isinstance(lines, list):
                raise RuntimeError(f"empty/invalid Eastmoney response rc={envelope.get('rc')}")
            payload = {
                "canonical": security.canonical,
                "secid": security.secid,
                "name": data.get("name") or security.name,
                "fqt": 2,
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
            }
        except Exception as error:  # pragma: no cover - network behavior
            last_error = error
            time.sleep(0.25 * (attempt + 1))
    return {
        "symbol": security.canonical,
        "status": "failed",
        "error": repr(last_error),
    }


def tencent_symbol(security: Security) -> str:
    return f"{security.exchange.lower()}{security.code}"


def fetch_tencent_series(
    security: Security, adjustment: str
) -> tuple[dict[str, list[Any]], str | None]:
    symbol = tencent_symbol(security)
    by_date: dict[str, list[Any]] = {}
    end = END
    name: str | None = None
    for page in range(6):
        param = f"{symbol},day,,{end},800,{adjustment}"
        url = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?" + urllib.parse.urlencode(
            {"param": param}
        )
        last_error: Exception | None = None
        envelope: dict[str, Any] | None = None
        for attempt in range(3):
            try:
                request = urllib.request.Request(
                    url,
                    headers={
                        "User-Agent": "Mozilla/5.0",
                        "Referer": "https://gu.qq.com/",
                        "Accept": "application/json,text/plain,*/*",
                    },
                )
                context = ssl._create_unverified_context()
                with urllib.request.urlopen(request, timeout=20, context=context) as response:
                    envelope = json.load(response)
                break
            except Exception as error:  # pragma: no cover - network behavior
                last_error = error
                time.sleep(0.15 * (attempt + 1))
        if envelope is None:
            raise RuntimeError(f"Tencent {symbol} {adjustment} page {page}: {last_error!r}")
        stock = (envelope.get("data") or {}).get(symbol)
        if not isinstance(stock, dict):
            if page == 0:
                return {}, None
            break
        key = f"{adjustment}day" if adjustment in {"hfq", "qfq"} else "day"
        rows = stock.get(key)
        if not isinstance(rows, list) or not rows:
            break
        quote = (stock.get("qt") or {}).get(symbol)
        if isinstance(quote, list) and len(quote) > 1 and isinstance(quote[1], str):
            name = quote[1]
        accepted_dates: list[str] = []
        for row in rows:
            if not isinstance(row, list) or len(row) < 6 or not isinstance(row[0], str):
                continue
            date = row[0]
            if START <= date <= END:
                by_date[date] = row
                accepted_dates.append(date)
        earliest = rows[0][0] if isinstance(rows[0], list) and rows[0] else None
        if not isinstance(earliest, str) or earliest <= START:
            break
        next_end = (dt.date.fromisoformat(earliest) - dt.timedelta(days=1)).isoformat()
        if next_end >= end:
            break
        end = next_end
    return by_date, name


def fetch_one_tencent(security: Security, cache_dir: Path, refresh: bool) -> dict[str, Any]:
    path = cache_path_for(cache_dir, security)
    if path.exists() and not refresh:
        return {"symbol": security.canonical, "status": "cached", "bytes": path.stat().st_size}
    try:
        adjusted, name = fetch_tencent_series(security, "hfq")
        raw, _ = fetch_tencent_series(security, "none")
        lines: list[str] = []
        for date in sorted(set(adjusted) & set(raw)):
            adjusted_row = adjusted[date]
            raw_row = raw[date]
            if len(adjusted_row) < 6 or len(raw_row) < 6:
                continue
            try:
                open_price, close, high, low, volume = map(float, adjusted_row[1:6])
                raw_close = float(raw_row[2])
            except (TypeError, ValueError):
                continue
            # Tencent volume is in hands; raw close * volume * 100 closely tracks
            # turnover amount and avoids applying an adjusted price to liquidity.
            amount_proxy = raw_close * volume * 100
            lines.append(
                f"{date},{open_price:.6f},{close:.6f},{high:.6f},{low:.6f},"
                f"{volume:.6f},{amount_proxy:.2f}"
            )
        payload = {
            "canonical": security.canonical,
            "secid": security.secid,
            "name": name or security.name,
            "provider": "Tencent fqkline",
            "fqt": "hfq",
            "amount_semantics": "raw close * volume_in_hands * 100 proxy",
            "fields": "date,open,close,high,low,volume,amount_proxy",
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
            "provider": "Tencent",
        }
    except Exception as error:  # pragma: no cover - network behavior
        return {"symbol": security.canonical, "status": "failed", "error": repr(error)}


def fetch_url_bytes(url: str, referer: str, attempts: int = 3) -> bytes:
    last_error: Exception | None = None
    for attempt in range(attempts):
        try:
            throttle_request()
            request = urllib.request.Request(
                url,
                headers={
                    "User-Agent": "Mozilla/5.0",
                    "Referer": referer,
                    "Accept": "application/json,text/plain,*/*",
                },
            )
            context = ssl._create_unverified_context()
            with urllib.request.urlopen(request, timeout=25, context=context) as response:
                return response.read()
        except Exception as error:  # pragma: no cover - network behavior
            last_error = error
            time.sleep(0.20 * (attempt + 1))
    raise RuntimeError(f"request failed: {url}: {last_error!r}")


def fetch_one_sina(security: Security, cache_dir: Path, refresh: bool) -> dict[str, Any]:
    path = cache_path_for(cache_dir, security)
    if path.exists() and not refresh:
        return {"symbol": security.canonical, "status": "cached", "bytes": path.stat().st_size}
    symbol = tencent_symbol(security)
    # The mobile JSONP endpoint reliably caps a response just below 2,000 bars.
    # 1,900 gives roughly 7.5 years for active names while still covering the
    # terminal history of delisted names. Longer 2014 histories already cached
    # from Tencent/Eastmoney remain untouched and are disclosed separately.
    datalen = 1900
    callback = f"_{symbol}_240_{datalen}"
    kline_url = (
        f"https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20{callback}=/"
        "CN_MarketDataService.getKLineData?"
        + urllib.parse.urlencode(
            {"symbol": symbol, "scale": "240", "ma": "no", "datalen": str(datalen)}
        )
    )
    factor_url = f"https://finance.sina.com.cn/realstock/company/{symbol}/houfuquan.js"
    try:
        kline_text = fetch_url_bytes(kline_url, "https://finance.sina.com.cn/").decode(
            "utf-8", errors="replace"
        )
        left = kline_text.find("=([")
        right = kline_text.rfind(");")
        if left < 0 or right <= left:
            raise RuntimeError("invalid Sina JSONP K-line response")
        raw_rows = json.loads(kline_text[left + 2 : right])
        factor_text = fetch_url_bytes(factor_url, "https://finance.sina.com.cn/").decode(
            "utf-8", errors="replace"
        )
        import re

        adjusted_close = {
            f"{year}-{month}-{day}": float(value)
            for year, month, day, value in re.findall(
                r'_(\d{4})_(\d{2})_(\d{2}):"(-?[0-9.]+)"', factor_text
            )
        }
        lines: list[str] = []
        if not isinstance(raw_rows, list):
            raw_rows = []
        for row in raw_rows:
            if not isinstance(row, dict):
                continue
            date = row.get("day")
            if not isinstance(date, str) or not (START <= date <= END):
                continue
            try:
                raw_open = float(row["open"])
                raw_high = float(row["high"])
                raw_low = float(row["low"])
                raw_close = float(row["close"])
                volume_shares = float(row["volume"])
            except (KeyError, TypeError, ValueError):
                continue
            target_close = adjusted_close.get(date, raw_close)
            factor = target_close / raw_close if raw_close > 0 else math.nan
            if not math.isfinite(factor) or factor <= 0:
                continue
            amount_proxy = raw_close * volume_shares
            lines.append(
                f"{date},{raw_open * factor:.6f},{target_close:.6f},"
                f"{raw_high * factor:.6f},{raw_low * factor:.6f},"
                f"{volume_shares:.6f},{amount_proxy:.2f}"
            )
        payload = {
            "canonical": security.canonical,
            "secid": security.secid,
            "name": security.name,
            "provider": "Sina CN_MarketData + houfuquan",
            "fqt": "houfuquan close-derived OHLC scale; raw fallback when factor unavailable",
            "amount_semantics": "raw close * volume_in_shares proxy",
            "fields": "date,open,close,high,low,volume,amount_proxy",
            "factor_dates": len(adjusted_close),
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
            "provider": "Sina",
        }
    except Exception as error:  # pragma: no cover - network behavior
        return {"symbol": security.canonical, "status": "failed", "error": repr(error)}


def fetch_one(
    security: Security, cache_dir: Path, refresh: bool, provider: str
) -> dict[str, Any]:
    selected = provider
    if selected == "auto":
        selected = "sina"
    if selected == "tencent" and security.exchange == "BJ":
        selected = "eastmoney"
    if selected == "tencent":
        return fetch_one_tencent(security, cache_dir, refresh)
    if selected == "sina":
        return fetch_one_sina(security, cache_dir, refresh)
    return fetch_one_eastmoney(security, cache_dir, refresh)


def download_all(
    securities: Sequence[Security], cache_dir: Path, refresh: bool, workers: int,
    provider: str,
) -> dict[str, Any]:
    force_ipv4()
    results: list[dict[str, Any]] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
        futures = [
            executor.submit(fetch_one, security, cache_dir, refresh, provider)
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
                print(f"download {index}/{len(futures)} {counts}", file=sys.stderr, flush=True)
    manifest = {
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "provider": (
            "Sina adjusted/raw proxy with cached Tencent/Eastmoney overlap"
            if provider == "auto" else provider
        ),
        "adjustment": "back-adjusted/hfq",
        "requested_start": START,
        "requested_end": END,
        "universe": len(securities),
        "results": sorted(results, key=lambda item: item["symbol"]),
    }
    path = cache_dir / "download-manifest.json"
    path.write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
    return manifest


def load_bars(path: Path) -> tuple[dict[str, Any], list[str], np.ndarray]:
    with gzip.open(path, "rt", encoding="utf-8") as handle:
        payload = json.load(handle)
    dates: list[str] = []
    rows: list[tuple[float, float, float, float, float, float]] = []
    rejected = 0
    for raw in payload.get("klines", []):
        if not isinstance(raw, str):
            rejected += 1
            continue
        parts = raw.split(",")
        if len(parts) < 7:
            rejected += 1
            continue
        try:
            open_price, close, high, low, volume, amount = map(float, parts[1:7])
        except ValueError:
            rejected += 1
            continue
        if (
            min(open_price, close, high, low) <= 0
            or high < max(open_price, close, low)
            or low > min(open_price, close, high)
            or volume <= 0
            or amount <= 0
        ):
            rejected += 1
            continue
        dates.append(parts[0])
        rows.append((open_price, close, high, low, volume, amount))
    payload["raw_rows"] = len(payload.get("klines", []))
    payload["rejected_nontradable_or_invalid_rows"] = rejected
    return payload, dates, np.asarray(rows, dtype=np.float64)


def rolling_mean(values: np.ndarray, window: int, prior: bool) -> np.ndarray:
    result = np.full(values.shape, np.nan, dtype=np.float64)
    cumulative = np.concatenate(([0.0], np.cumsum(values, dtype=np.float64)))
    if prior:
        indexes = np.arange(window, len(values))
        result[indexes] = (cumulative[indexes] - cumulative[indexes - window]) / window
    else:
        indexes = np.arange(window - 1, len(values))
        result[indexes] = (
            cumulative[indexes + 1] - cumulative[indexes + 1 - window]
        ) / window
    return result


def rolling_sum(values: np.ndarray, window: int) -> np.ndarray:
    result = np.full(values.shape, np.nan, dtype=np.float64)
    cumulative = np.concatenate(([0.0], np.cumsum(values, dtype=np.float64)))
    indexes = np.arange(window - 1, len(values))
    result[indexes] = cumulative[indexes + 1] - cumulative[indexes + 1 - window]
    return result


def rolling_extreme_prior(values: np.ndarray, window: int, maximum: bool) -> np.ndarray:
    result = np.full(values.shape, np.nan, dtype=np.float64)
    queue: deque[int] = deque()
    for index, value in enumerate(values):
        while queue and queue[0] < index - window:
            queue.popleft()
        if index >= window and queue:
            result[index] = values[queue[0]]
        while queue and (
            values[queue[-1]] <= value if maximum else values[queue[-1]] >= value
        ):
            queue.pop()
        queue.append(index)
    return result


def rolling_median_prior(values: np.ndarray, window: int) -> np.ndarray:
    result = np.full(values.shape, np.nan, dtype=np.float64)
    if len(values) <= window:
        return result
    windows = np.lib.stride_tricks.sliding_window_view(values, window)
    result[window:] = np.median(windows[:-1], axis=1)
    return result


def build_features(dates: list[str], rows: np.ndarray) -> Features:
    open_price, close, high, low, volume, amount = (rows[:, index] for index in range(6))
    ma5 = rolling_mean(close, 5, prior=False)
    ma10 = rolling_mean(close, 10, prior=False)
    ma20 = rolling_mean(close, 20, prior=False)
    ma60 = rolling_mean(close, 60, prior=False)
    vma20 = rolling_mean(volume, 20, prior=True)
    vma60 = rolling_mean(volume, 60, prior=True)
    amount20 = rolling_median_prior(amount, 20)
    previous_close = np.concatenate(([close[0]], close[:-1]))
    true_range = np.maximum(high - low, np.maximum(abs(high - previous_close), abs(low - previous_close)))
    atr20 = rolling_mean(true_range, 20, prior=True)
    hh20 = rolling_extreme_prior(high, 20, maximum=True)
    ll20 = rolling_extreme_prior(low, 20, maximum=False)
    hh60 = rolling_extreme_prior(high, 60, maximum=True)
    with np.errstate(divide="ignore", invalid="ignore"):
        dd60 = close / hh60 - 1
        ret20_prior = np.concatenate((np.full(21, np.nan), close[20:-1] / close[:-21] - 1))
        volume_ratio = volume / vma20
    below = np.where(np.isfinite(ma20), close < ma20, False).astype(np.float64)
    below20 = rolling_sum(below, 20)
    bar_range = high - low
    safe_range = np.where(bar_range > 0, bar_range, np.nan)
    clv = (close - low) / safe_range
    lower_shadow = (np.minimum(open_price, close) - low) / safe_range
    upper_shadow = (high - np.maximum(open_price, close)) / safe_range
    body = abs(close - open_price) / safe_range
    return Features(
        dates=dates,
        open=open_price,
        close=close,
        high=high,
        low=low,
        volume=volume,
        amount=amount,
        ma5=ma5,
        ma10=ma10,
        ma20=ma20,
        ma60=ma60,
        vma20_prior=vma20,
        vma60_prior=vma60,
        amount20_median_prior=amount20,
        atr20_prior=atr20,
        hh20_prior=hh20,
        ll20_prior=ll20,
        hh60_prior=hh60,
        dd60=dd60,
        ret20_prior=ret20_prior,
        below20=below20,
        clv=clv,
        lower_shadow=lower_shadow,
        upper_shadow=upper_shadow,
        body=body,
        true_range=true_range,
        volume_ratio=volume_ratio,
    )


def finite(*values: float) -> bool:
    return all(math.isfinite(float(value)) for value in values)


def volume_layer(ratio: float) -> str | None:
    if not math.isfinite(ratio):
        return None
    if ratio <= 0.70:
        return "dry"
    if ratio < 2.50:
        return "normal"
    return "huge"


def detect_signals(features: Features) -> dict[str, list[tuple[int, int, str | None]]]:
    """Return signal-index, anchor-index and optional anchor-volume layer."""

    n = len(features.dates)
    found: dict[str, list[tuple[int, int, str | None]]] = {
        definition.key: [] for definition in SIGNALS
    }
    hammer_anchors: list[int] = []
    capitulation_anchors: list[int] = []
    dry_anchors: list[int] = []
    upper_anchors: list[int] = []
    failed_anchors: list[int] = []
    double_bottom_anchors: list[tuple[int, float]] = []
    double_top_anchors: list[tuple[int, float]] = []

    for index in range(MIN_LISTED_BARS, n):
        values = (
            features.dd60[index], features.below20[index], features.atr20_prior[index],
            features.volume_ratio[index], features.clv[index], features.body[index],
            features.lower_shadow[index], features.upper_shadow[index],
            features.hh20_prior[index], features.ll20_prior[index],
            features.ma5[index], features.ma10[index], features.ma20[index],
        )
        if not finite(*values) or features.true_range[index] <= 0:
            continue
        dd60 = features.dd60[index]
        below20 = features.below20[index]
        atr = features.atr20_prior[index]
        vr = features.volume_ratio[index]
        clv = features.clv[index]

        if (
            index >= 11
            and dd60 <= -0.15
            and features.close[index - 1] / features.close[index - 11] - 1 <= -0.10
            and below20 >= 10
            and features.low[index] < features.low[index - 1]
            and features.high[index] > features.high[index - 1]
            and features.close[index] > features.high[index - 1]
            and features.close[index] > features.open[index]
            and clv >= 0.75
            and features.true_range[index] >= 1.20 * atr
            and vr >= 1.20
        ):
            found["low_bullish_outside"].append((index, index, volume_layer(vr)))

        hammer = (
            dd60 <= -0.20
            and below20 >= 10
            and features.low[index] <= features.ll20_prior[index]
            and features.close[index] >= features.ll20_prior[index]
            and features.lower_shadow[index] >= 0.50
            and clv >= 0.65
            and features.body[index] <= 0.35
            and features.true_range[index] >= 0.80 * atr
        )
        if hammer:
            layer = volume_layer(vr)
            found["hammer_spring_raw"].append((index, index, layer))
            hammer_anchors.append(index)

        bottom_huge = (
            dd60 <= -0.25
            and below20 >= 10
            and features.close[index] <= features.ma20[index]
            and vr >= 2.50
            and features.close[index] > features.open[index]
            and clv >= 0.70
        )
        if bottom_huge:
            found["bottom_huge_strong_close"].append((index, index, "huge"))

        capitulation = (
            dd60 <= -0.20
            and below20 >= 10
            and vr >= 2.50
            and features.close[index] < features.open[index]
            and clv <= 0.30
            and features.body[index] >= 0.50
            and features.true_range[index] >= 1.50 * atr
        )
        if capitulation:
            found["capitulation_anchor"].append((index, index, "huge"))
            capitulation_anchors.append(index)

        if index >= 60:
            old_floor = float(np.min(features.low[index - 22 : index - 3]))
            platform_low = float(np.min(features.low[index - 2 : index + 1]))
            median_three = float(np.median(features.volume[index - 2 : index + 1]))
            dry = (
                dd60 <= -0.15
                and below20 >= 10
                and finite(features.vma60_prior[index])
                and features.vma60_prior[index] > 0
                and median_three / features.vma60_prior[index] <= 0.45
                and platform_low >= 0.98 * old_floor
                and abs(features.close[index] / features.close[index - 3] - 1) <= 0.03
            )
            if dry:
                found["extreme_dry_stabilize_raw"].append((index, index, "dry"))
                dry_anchors.append(index)

        if index >= 40:
            prior_slice = slice(index - 40, index - 9)
            lows = features.low[prior_slice]
            highs = features.high[prior_slice]
            trough = index - 40 + int(np.argmin(lows))
            peak = index - 40 + int(np.argmax(highs))
            trough_q = features.volume_ratio[trough]
            peak_q = features.volume_ratio[peak]
            if (
                dd60 <= -0.15
                and finite(trough_q)
                and trough_q > 0
                and 0.97 <= features.low[index] / features.low[trough] <= 1.03
                and features.close[index] >= features.low[trough]
                and features.lower_shadow[index] >= 0.25
                and vr <= 0.70 * trough_q
            ):
                neckline = float(np.max(features.high[trough + 1 : index]))
                found["double_bottom_volume_divergence_raw"].append(
                    (index, index, volume_layer(vr))
                )
                double_bottom_anchors.append((index, neckline))
            if (
                features.ret20_prior[index] >= 0.10
                and finite(peak_q)
                and peak_q > 0
                and 0.98 <= features.high[index] / features.high[peak] <= 1.05
                and vr <= 0.70 * peak_q
                and features.upper_shadow[index] >= 0.20
                and clv <= 0.55
            ):
                neckline = float(np.min(features.low[peak + 1 : index]))
                found["double_top_volume_divergence_raw"].append(
                    (index, index, volume_layer(vr))
                )
                double_top_anchors.append((index, neckline))

        upper = (
            features.ret20_prior[index] >= 0.15
            and index >= 3
            and features.ma5[index] > features.ma10[index]
            and features.ma10[index] > features.ma10[index - 3]
            and features.close[index - 1] > features.ma5[index - 1]
            and features.high[index] >= features.hh20_prior[index]
            and vr >= 2.50
            and features.upper_shadow[index] >= 0.55
            and clv <= 0.35
            and features.true_range[index] >= atr
        )
        if upper:
            found["huge_upper_rejection_raw"].append((index, index, "huge"))
            upper_anchors.append(index)

        failed = (
            not upper
            and features.ret20_prior[index] >= 0.10
            and features.ma5[index] > features.ma10[index]
            and features.high[index] >= 1.005 * features.hh20_prior[index]
            and features.close[index] <= features.hh20_prior[index]
            and vr >= 1.50
            and clv <= 0.45
            and features.upper_shadow[index] >= 0.25
        )
        if failed:
            found["failed_breakout_raw"].append((index, index, volume_layer(vr)))
            failed_anchors.append(index)

    for anchor in hammer_anchors:
        invalidation = features.low[anchor] - 0.25 * features.atr20_prior[anchor]
        for confirm in range(anchor + 1, min(anchor + 4, n)):
            if features.low[confirm] < invalidation:
                break
            if (
                features.close[confirm] > features.high[anchor]
                and features.close[confirm] > features.ma5[confirm]
                and features.clv[confirm] >= 0.55
            ):
                found["hammer_spring_confirmed"].append(
                    (confirm, anchor, volume_layer(features.volume_ratio[anchor]))
                )
                break

    for anchor in capitulation_anchors:
        midpoint = (features.high[anchor] + features.low[anchor]) / 2
        for confirm in range(anchor + 2, min(anchor + 8, n)):
            if float(np.min(features.low[anchor + 1 : confirm + 1])) < 0.98 * features.low[anchor]:
                break
            prior_ratios = features.volume_ratio[anchor + 1 : confirm]
            if (
                len(prior_ratios) > 0
                and np.any(prior_ratios <= 0.70)
                and features.close[confirm] > max(features.high[confirm - 1], midpoint)
                and features.close[confirm] > features.open[confirm]
                and features.clv[confirm] >= 0.65
                and 1.00 <= features.volume_ratio[confirm] <= 3.50
            ):
                found["capitulation_retest_confirmed"].append((confirm, anchor, "huge"))
                break

    for anchor in dry_anchors:
        platform_low = float(np.min(features.low[anchor - 2 : anchor + 1]))
        platform_high = float(np.max(features.high[anchor - 2 : anchor + 1]))
        for confirm in range(anchor + 1, min(anchor + 4, n)):
            if features.low[confirm] < 0.98 * platform_low:
                break
            if (
                features.close[confirm] > platform_high
                and features.close[confirm] > features.ma5[confirm]
                and features.close[confirm] > features.open[confirm]
                and features.clv[confirm] >= 0.65
                and 1.00 <= features.volume_ratio[confirm] <= 3.50
            ):
                found["extreme_dry_stabilize_confirmed"].append((confirm, anchor, "dry"))
                break

    for anchor in upper_anchors:
        for confirm in range(anchor + 1, min(anchor + 4, n)):
            if features.close[confirm] < features.low[anchor]:
                found["huge_upper_rejection_confirmed"].append((confirm, anchor, "huge"))
                break

    for anchor in failed_anchors:
        for confirm in range(anchor + 1, min(anchor + 3, n)):
            if features.close[confirm] < features.low[anchor]:
                found["failed_breakout_confirmed"].append(
                    (confirm, anchor, volume_layer(features.volume_ratio[anchor]))
                )
                break

    for anchor, neckline in double_bottom_anchors:
        for confirm in range(anchor + 1, min(anchor + 6, n)):
            if features.low[confirm] < 0.97 * features.low[anchor]:
                break
            if (
                features.close[confirm] > neckline
                and features.clv[confirm] >= 0.65
                and features.volume_ratio[confirm] >= 1.20
            ):
                found["double_bottom_volume_divergence_confirmed"].append(
                    (confirm, anchor, volume_layer(features.volume_ratio[anchor]))
                )
                break

    for anchor, neckline in double_top_anchors:
        for confirm in range(anchor + 1, min(anchor + 6, n)):
            if features.high[confirm] > 1.05 * features.high[anchor]:
                break
            if (
                features.close[confirm] < neckline
                and features.clv[confirm] <= 0.35
                and features.volume_ratio[confirm] >= 1.20
            ):
                found["double_top_volume_divergence_confirmed"].append(
                    (confirm, anchor, volume_layer(features.volume_ratio[anchor]))
                )
                break

    for definition in SIGNALS:
        deduped: list[tuple[int, int, str | None]] = []
        last = -10_000
        seen_indexes: set[int] = set()
        for item in sorted(found[definition.key]):
            signal_index = item[0]
            if signal_index in seen_indexes or signal_index - last < definition.cooldown:
                continue
            deduped.append(item)
            seen_indexes.add(signal_index)
            last = signal_index
        found[definition.key] = deduped
    return found


def limit_ratio(security: Security, date: str) -> float:
    if security.board == "BSE":
        return 0.30
    if security.board == "STAR":
        return 0.20
    if security.board == "CHINEXT" and date >= "2020-08-24":
        return 0.20
    return 0.10


def one_price_limit_up(features: Features, signal_index: int, security: Security) -> bool:
    entry = signal_index + 1
    if entry >= len(features.dates):
        return True
    ratio = limit_ratio(security, features.dates[entry])
    limit = features.close[signal_index] * (1 + ratio)
    tolerance = max(0.01, features.close[signal_index] * 0.0008)
    return features.low[entry] >= limit - tolerance


def board_group(board: str) -> str:
    if board in {"STAR", "CHINEXT"}:
        return "GROWTH_20PCT"
    if board == "BSE":
        return "BSE_30PCT"
    return "MAIN_10PCT"


def context_keys(features: Features, index: int, side: str, board: str) -> tuple[str, str]:
    if side == "buy":
        value = features.dd60[index]
        location = "dd35" if value <= -0.35 else "dd25" if value <= -0.25 else "dd15" if value <= -0.15 else "dd0"
    else:
        value = features.ret20_prior[index]
        location = "up25" if value >= 0.25 else "up15" if value >= 0.15 else "up10" if value >= 0.10 else "up0"
    liquidity = features.amount20_median_prior[index]
    liquidity_tier = "liq100" if liquidity >= 100_000_000 else "liq50" if liquidity >= 50_000_000 else "liq30"
    coarse = f"{side}|{location}|{board_group(board)}"
    return f"{coarse}|{liquidity_tier}", coarse


def symbol_fold(symbol: str, prior_studied: set[str]) -> str:
    if symbol in prior_studied:
        return "prior_studied"
    bucket = int(hashlib.sha256(symbol.encode()).hexdigest()[:8], 16) % 10
    if bucket <= 4:
        return "expanded_development"
    if bucket <= 7:
        return "expanded_validation"
    return "expanded_test"


def outcome_returns(features: Features, signal_index: int, horizon: int) -> tuple[float, float]:
    entry = signal_index + 1
    exit_index = signal_index + horizon
    raw = features.close[exit_index] / features.open[entry] - 1
    entry_effective = features.open[entry] * (1 + SLIPPAGE) / (1 - BUY_COST)
    exit_effective = features.close[exit_index] * (1 - SLIPPAGE) * (1 - SELL_COST)
    return raw, exit_effective / entry_effective - 1


def add_control(
    controls: dict[tuple[str, int, str], list[float]],
    key: tuple[str, int, str],
    directional: bool,
    signed_return: float,
) -> None:
    aggregate = controls.setdefault(key, [0.0, 0.0, 0.0])
    aggregate[0] += 1
    aggregate[1] += float(directional)
    aggregate[2] += signed_return


def collect_security(
    security: Security,
    cache_dir: Path,
    prior_studied: set[str],
    controls_exact: dict[tuple[str, int, str], list[float]],
    controls_coarse: dict[tuple[str, int, str], list[float]],
) -> tuple[list[Event], dict[str, Any]]:
    path = cache_path_for(cache_dir, security)
    if not path.exists():
        return [], {"status": "missing"}
    payload, dates, rows = load_bars(path)
    quality = {
        "status": "loaded",
        "provider": payload.get("provider") or "Eastmoney history K-line",
        "raw_rows": int(payload["raw_rows"]),
        "valid_rows": len(dates),
        "rejected_rows": int(payload["rejected_nontradable_or_invalid_rows"]),
        "first_date": dates[0] if dates else None,
        "last_date": dates[-1] if dates else None,
    }
    if len(dates) < MIN_LISTED_BARS + max(HORIZONS) + 1:
        quality["status"] = "too_short"
        return [], quality
    features = build_features(dates, rows)
    signals = detect_signals(features)
    fold = symbol_fold(security.canonical, prior_studied)

    last_signal_index = len(dates) - max(HORIZONS)
    for index in range(MIN_LISTED_BARS, last_signal_index):
        liquidity = features.amount20_median_prior[index]
        if not finite(liquidity, features.dd60[index], features.ret20_prior[index]) or liquidity < PRIMARY_LIQUIDITY:
            continue
        for horizon in HORIZONS:
            if index + horizon >= len(dates):
                continue
            raw, net = outcome_returns(features, index, horizon)
            for side in ("buy", "sell"):
                if side == "buy" and one_price_limit_up(features, index, security):
                    continue
                exact, coarse = context_keys(features, index, side, security.board)
                signed = net if side == "buy" else -raw
                directional = signed > 0
                add_control(controls_exact, (dates[index], horizon, exact), directional, signed)
                add_control(controls_coarse, (dates[index], horizon, coarse), directional, signed)

    events: list[Event] = []
    for signal_key, observations in signals.items():
        definition = SIGNAL_BY_KEY[signal_key]
        for signal_index, anchor_index, layer in observations:
            liquidity = features.amount20_median_prior[signal_index]
            if not finite(liquidity) or liquidity < PRIMARY_LIQUIDITY:
                continue
            if definition.side == "buy" and one_price_limit_up(features, signal_index, security):
                continue
            exact, coarse = context_keys(features, signal_index, definition.side, security.board)
            for horizon in HORIZONS:
                exit_index = signal_index + horizon
                if signal_index + 1 >= len(dates) or exit_index >= len(dates):
                    continue
                raw, net = outcome_returns(features, signal_index, horizon)
                directional = net > 0 if definition.side == "buy" else raw < 0
                events.append(Event(
                    signal=signal_key,
                    side=definition.side,
                    family=definition.family,
                    symbol=security.canonical,
                    board=security.board,
                    fold=fold,
                    signal_date=dates[signal_index],
                    anchor_date=dates[anchor_index],
                    entry_date=dates[signal_index + 1],
                    exit_date=dates[exit_index],
                    horizon=horizon,
                    raw_return=float(raw),
                    net_return=float(net),
                    direction_hit=bool(directional),
                    context_key=exact,
                    coarse_context_key=coarse,
                    volume_layer=layer,
                    entry_gap=float(features.open[signal_index + 1] / features.close[signal_index] - 1),
                    liquidity=float(liquidity),
                ))
    quality["events"] = len(events)
    return events, quality


def wilson_interval(successes: int, total: int, z: float = 1.959963984540054) -> list[float] | None:
    if total <= 0:
        return None
    rate = successes / total
    denominator = 1 + z * z / total
    center = (rate + z * z / (2 * total)) / denominator
    radius = z * math.sqrt(rate * (1 - rate) / total + z * z / (4 * total * total)) / denominator
    return [max(0.0, center - radius), min(1.0, center + radius)]


def percentile(values: Sequence[float], quantile: float) -> float | None:
    if not values:
        return None
    return float(np.quantile(np.asarray(values, dtype=np.float64), quantile))


def two_way_cluster_ci(
    values: Sequence[float], symbols: Sequence[str], months: Sequence[str]
) -> dict[str, Any] | None:
    if len(values) < 2:
        return None
    mean = statistics.fmean(values)
    centered = [value - mean for value in values]

    def sums_by(labels: Sequence[Any]) -> list[float]:
        grouped: dict[Any, float] = defaultdict(float)
        for label, value in zip(labels, centered, strict=True):
            grouped[label] += value
        return list(grouped.values())

    stock_sums = sums_by(symbols)
    month_sums = sums_by(months)
    cell_sums = sums_by(list(zip(symbols, months, strict=True)))

    def component(grouped: Sequence[float]) -> float:
        count = len(grouped)
        if count <= 1:
            return 0.0
        return count / (count - 1) * sum(value * value for value in grouped)

    variance = (
        component(stock_sums) + component(month_sums) - component(cell_sums)
    ) / (len(values) * len(values))
    variance = max(0.0, variance)
    standard_error = math.sqrt(variance)
    lower = mean - 1.959963984540054 * standard_error
    upper = mean + 1.959963984540054 * standard_error
    if standard_error == 0:
        one_sided_p = 0.0 if mean > 0 else 1.0
    else:
        z_score = mean / standard_error
        one_sided_p = 0.5 * math.erfc(z_score / math.sqrt(2))
    return {
        "mean": mean,
        "standard_error": standard_error,
        "ci95": [lower, upper],
        "one_sided_p_positive": one_sided_p,
        "stock_clusters": len(stock_sums),
        "month_clusters": len(month_sums),
        "stock_month_cells": len(cell_sums),
        "method": "two-way cluster-robust normal interval (stock and signal month)",
    }


def matched_control(
    event: Event,
    controls_exact: Mapping[tuple[str, int, str], Sequence[float]],
    controls_coarse: Mapping[tuple[str, int, str], Sequence[float]],
) -> tuple[float, float, int] | None:
    exact = controls_exact.get((event.signal_date, event.horizon, event.context_key))
    selected = exact if exact is not None and exact[0] >= 20 else None
    if selected is None:
        coarse = controls_coarse.get(
            (event.signal_date, event.horizon, event.coarse_context_key)
        )
        selected = coarse if coarse is not None and coarse[0] >= 20 else None
    if selected is None or selected[0] <= 0:
        return None
    return selected[1] / selected[0], selected[2] / selected[0], int(selected[0])


def summarize_events(
    events: Sequence[Event],
    controls_exact: Mapping[tuple[str, int, str], Sequence[float]],
    controls_coarse: Mapping[tuple[str, int, str], Sequence[float]],
) -> dict[str, Any]:
    if not events:
        return {
            "events": 0,
            "direction_rate": None,
            "direction_rate_wilson_95ci": None,
            "mean_signed_return": None,
            "median_signed_return": None,
            "matched_events": 0,
        }
    hits = [event.direction_hit for event in events]
    signed_returns = [
        event.net_return if event.side == "buy" else -event.raw_return
        for event in events
    ]
    raw_returns = [event.raw_return for event in events]
    months = [event.signal_date[:7] for event in events]
    symbols = [event.symbol for event in events]
    matched_direction: list[float] = []
    matched_excess: list[float] = []
    matched_symbols: list[str] = []
    matched_months: list[str] = []
    matched_sizes: list[int] = []
    expected_rates: list[float] = []
    expected_signed: list[float] = []
    for event, hit, signed in zip(events, hits, signed_returns, strict=True):
        control = matched_control(event, controls_exact, controls_coarse)
        if control is None:
            continue
        expected_rate, expected_return, size = control
        matched_direction.append(float(hit) - expected_rate)
        matched_excess.append(signed - expected_return)
        matched_symbols.append(event.symbol)
        matched_months.append(event.signal_date[:7])
        matched_sizes.append(size)
        expected_rates.append(expected_rate)
        expected_signed.append(expected_return)

    positive_returns = [value for value in signed_returns if value > 0]
    negative_returns = [value for value in signed_returns if value <= 0]
    sorted_returns = sorted(signed_returns)
    keep = max(1, math.floor(len(sorted_returns) * 0.95))
    trimmed = sorted_returns[:keep]
    profit_factor = (
        sum(positive_returns) / abs(sum(negative_returns))
        if negative_returns and sum(negative_returns) < 0
        else None
    )
    payoff_ratio = (
        statistics.fmean(positive_returns) / abs(statistics.fmean(negative_returns))
        if positive_returns and negative_returns and statistics.fmean(negative_returns) < 0
        else None
    )
    return {
        "events": len(events),
        "symbols": len(set(symbols)),
        "months": len(set(months)),
        "first_signal": min(event.signal_date for event in events),
        "last_signal": max(event.signal_date for event in events),
        "direction_hits": sum(hits),
        "direction_rate": sum(hits) / len(events),
        "direction_rate_wilson_95ci": wilson_interval(sum(hits), len(events)),
        "mean_signed_return": statistics.fmean(signed_returns),
        "median_signed_return": statistics.median(signed_returns),
        "signed_return_p05": percentile(signed_returns, 0.05),
        "signed_return_p95": percentile(signed_returns, 0.95),
        "mean_raw_underlying_return": statistics.fmean(raw_returns),
        "profit_factor_signed": profit_factor,
        "average_win_loss_payoff_ratio": payoff_ratio,
        "mean_signed_return_without_best_5pct": statistics.fmean(trimmed),
        "raw_direction_two_way_cluster": two_way_cluster_ci(
            [float(hit) for hit in hits], symbols, months
        ),
        "raw_signed_return_two_way_cluster": two_way_cluster_ci(
            signed_returns, symbols, months
        ),
        "matched_events": len(matched_direction),
        "matched_coverage": len(matched_direction) / len(events),
        "matched_median_control_pool": (
            statistics.median(matched_sizes) if matched_sizes else None
        ),
        "matched_expected_direction_rate": (
            statistics.fmean(expected_rates) if expected_rates else None
        ),
        "matched_direction_uplift": (
            statistics.fmean(matched_direction) if matched_direction else None
        ),
        "matched_direction_uplift_two_way_cluster": two_way_cluster_ci(
            matched_direction, matched_symbols, matched_months
        ),
        "matched_expected_signed_return": (
            statistics.fmean(expected_signed) if expected_signed else None
        ),
        "matched_mean_signed_excess": (
            statistics.fmean(matched_excess) if matched_excess else None
        ),
        "matched_signed_excess_two_way_cluster": two_way_cluster_ci(
            matched_excess, matched_symbols, matched_months
        ),
        "median_next_open_gap": statistics.median(event.entry_gap for event in events),
        "mean_next_open_gap": statistics.fmean(event.entry_gap for event in events),
    }


def time_subset(events: Sequence[Event], start: str, end: str) -> list[Event]:
    return [
        event for event in events
        if event.signal_date >= start and event.exit_date <= end
    ]


def signal_report(
    signal_events: Sequence[Event],
    definition: SignalDefinition,
    controls_exact: Mapping[tuple[str, int, str], Sequence[float]],
    controls_coarse: Mapping[tuple[str, int, str], Sequence[float]],
) -> dict[str, Any]:
    expanded = [event for event in signal_events if event.fold != "prior_studied"]
    report: dict[str, Any] = {
        "definition": dataclasses.asdict(definition),
        "horizons": {},
    }
    for horizon in HORIZONS:
        horizon_all = [event for event in signal_events if event.horizon == horizon]
        horizon_expanded = [event for event in expanded if event.horizon == horizon]
        report["horizons"][str(horizon)] = {
            "all_market": summarize_events(horizon_all, controls_exact, controls_coarse),
            "expanded_unseen_symbols": summarize_events(
                horizon_expanded, controls_exact, controls_coarse
            ),
        }

    primary = [event for event in expanded if event.horizon == definition.primary_horizon]
    report["primary_horizon_diagnostics"] = {
        "folds": {
            fold: summarize_events(
                [event for event in primary if event.fold == fold],
                controls_exact,
                controls_coarse,
            )
            for fold in (
                "expanded_development", "expanded_validation", "expanded_test"
            )
        },
        "eras_purged_at_boundaries": {
            label: summarize_events(
                time_subset(primary, start, end), controls_exact, controls_coarse
            )
            for label, start, end in (
                ("2014_2020", "2014-01-01", "2020-12-31"),
                ("2021_2023", "2021-01-01", "2023-12-31"),
                ("2024_2026", "2024-01-01", END),
            )
        },
        "years_purged_at_boundaries": {
            str(year): summarize_events(
                time_subset(primary, f"{year}-01-01", f"{year}-12-31"),
                controls_exact,
                controls_coarse,
            )
            for year in range(2014, 2027)
        },
        "boards": {
            board: summarize_events(
                [event for event in primary if event.board == board],
                controls_exact,
                controls_coarse,
            )
            for board in ("SH_MAIN", "SZ_MAIN", "STAR", "CHINEXT", "BSE")
        },
        "liquidity_sensitivity_50m": summarize_events(
            [event for event in primary if event.liquidity >= SENSITIVITY_LIQUIDITY],
            controls_exact,
            controls_coarse,
        ),
        "anchor_volume_layers": {
            layer: summarize_events(
                [event for event in primary if event.volume_layer == layer],
                controls_exact,
                controls_coarse,
            )
            for layer in ("dry", "normal", "huge")
        },
    }
    return report


def holm_adjust(p_values: Mapping[str, float | None]) -> dict[str, float | None]:
    available = sorted(
        ((key, value) for key, value in p_values.items() if value is not None),
        key=lambda item: float(item[1]),
    )
    adjusted: dict[str, float | None] = {key: None for key in p_values}
    running = 0.0
    total = len(available)
    for rank, (key, raw) in enumerate(available):
        running = max(running, min(1.0, (total - rank) * float(raw)))
        adjusted[key] = running
    return adjusted


def source_validation(
    securities: Mapping[str, Security], cache_dir: Path, prior_artifact: Path
) -> dict[str, Any]:
    legacy_cache = Path("/tmp/hanai-kline-backtest-cache")
    if not prior_artifact.exists() or not legacy_cache.exists():
        return {"status": "unavailable"}
    baseline = json.loads(prior_artifact.read_text(encoding="utf-8"))
    symbols = sorted(baseline.get("universe", {}))[:80]
    absolute_return_differences: list[float] = []
    clv_differences: list[float] = []
    aligned_rows = 0
    compared_symbols = 0
    for symbol in symbols:
        security = securities.get(symbol)
        if security is None:
            continue
        east_path = cache_path_for(cache_dir, security)
        bao_path = legacy_cache / f"{symbol.replace('.', '-')}-{START}-{END}-qfq.json"
        if not east_path.exists() or not bao_path.exists():
            continue
        _, east_dates, east_rows = load_bars(east_path)
        east = {
            date: row for date, row in zip(east_dates, east_rows, strict=True)
        }
        raw_bao = json.loads(bao_path.read_text(encoding="utf-8"))
        bao: dict[str, tuple[float, float, float, float]] = {}
        for row in raw_bao:
            if len(row) < 9 or not row[0] or not row[2] or not row[3] or not row[4] or not row[5]:
                continue
            try:
                bao[row[0]] = tuple(map(float, (row[2], row[5], row[3], row[4])))
            except ValueError:
                continue
        common = sorted(set(east) & set(bao))
        if len(common) < 2:
            continue
        compared_symbols += 1
        previous: str | None = None
        for date in common:
            east_open, east_close, east_high, east_low = east[date][:4]
            bao_open, bao_close, bao_high, bao_low = bao[date]
            if previous is not None:
                east_previous = east[previous][1]
                bao_previous = bao[previous][1]
                absolute_return_differences.append(
                    abs((east_close / east_previous - 1) - (bao_close / bao_previous - 1))
                )
            east_range = east_high - east_low
            bao_range = bao_high - bao_low
            if east_range > 0 and bao_range > 0:
                clv_differences.append(
                    abs((east_close - east_low) / east_range - (bao_close - bao_low) / bao_range)
                )
            previous = date
            aligned_rows += 1
    return {
        "status": "completed" if compared_symbols else "unavailable",
        "providers": ["Full-market back-adjusted cache", "BaoStock adjustflag=2 frozen cache"],
        "symbols": compared_symbols,
        "aligned_rows": aligned_rows,
        "daily_return_abs_diff_median": percentile(absolute_return_differences, 0.50),
        "daily_return_abs_diff_p95": percentile(absolute_return_differences, 0.95),
        "daily_return_abs_diff_over_50bp_rate": (
            sum(value > 0.005 for value in absolute_return_differences)
            / len(absolute_return_differences)
            if absolute_return_differences else None
        ),
        "close_location_abs_diff_median": percentile(clv_differences, 0.50),
        "close_location_abs_diff_p95": percentile(clv_differences, 0.95),
        "note": "Back- and front-adjusted price levels differ; validation compares scale-free daily returns and candle close location.",
    }


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def write_event_ledger(events: Sequence[Event], cache_dir: Path) -> dict[str, Any]:
    path = cache_dir / "full-market-turning-events-v0.jsonl.gz"
    temporary = path.with_suffix(path.suffix + f".{os.getpid()}.tmp")
    with gzip.open(temporary, "wt", encoding="utf-8", compresslevel=6) as handle:
        for event in sorted(
            events, key=lambda item: (item.signal, item.symbol, item.signal_date, item.horizon)
        ):
            handle.write(json.dumps(dataclasses.asdict(event), ensure_ascii=False, separators=(",", ":")))
            handle.write("\n")
    temporary.replace(path)
    return {
        "path": str(path),
        "events": len(events),
        "compressed_bytes": path.stat().st_size,
        "sha256": sha256_file(path),
        "format": "gzip JSON Lines; one row per signal/horizon outcome",
    }


def primary_summary(report: Mapping[str, Any]) -> Mapping[str, Any]:
    horizon = str(report["definition"]["primary_horizon"])
    return report["horizons"][horizon]["expanded_unseen_symbols"]


def safe_lower(value: Any) -> float | None:
    if isinstance(value, Mapping):
        interval = value.get("ci95")
        if isinstance(interval, list) and len(interval) == 2:
            return float(interval[0])
    return None


def release_gate(
    signal_key: str,
    report: Mapping[str, Any],
    holm_p: float | None,
) -> dict[str, Any]:
    summary = primary_summary(report)
    diagnostics = report["primary_horizon_diagnostics"]
    years = diagnostics["years_purged_at_boundaries"]
    stable_years = sum(
        item.get("events", 0) >= 20
        and (item.get("direction_rate") or 0) > 0.50
        and (item.get("mean_signed_return") or 0) > 0
        for item in years.values()
    )
    validation = diagnostics["folds"]["expanded_validation"]
    test = diagnostics["folds"]["expanded_test"]
    direction_cluster = summary.get("raw_direction_two_way_cluster")
    uplift_cluster = summary.get("matched_direction_uplift_two_way_cluster")
    excess_cluster = summary.get("matched_signed_excess_two_way_cluster")
    checks = {
        "at_least_200_expanded_unseen_events": summary.get("events", 0) >= 200,
        "historical_direction_rate_at_least_60pct": (summary.get("direction_rate") or 0) >= 0.60,
        "two_way_cluster_direction_ci_lower_above_50pct": (safe_lower(direction_cluster) or -1) > 0.50,
        "matched_direction_uplift_ci_lower_above_zero": (safe_lower(uplift_cluster) or -1) > 0,
        "matched_signed_excess_ci_lower_above_zero": (safe_lower(excess_cluster) or -1) > 0,
        "holm_familywise_p_below_5pct": holm_p is not None and holm_p < 0.05,
        "mean_after_removing_best_5pct_positive": (
            summary.get("mean_signed_return_without_best_5pct") or -1
        ) > 0,
        "at_least_three_stable_years": stable_years >= 3,
        "validation_fold_at_least_55pct": (
            validation.get("events", 0) >= 50
            and (validation.get("direction_rate") or 0) >= 0.55
        ),
        "test_fold_at_least_55pct": (
            test.get("events", 0) >= 50
            and (test.get("direction_rate") or 0) >= 0.55
        ),
    }
    return {
        "signal": signal_key,
        "stable_years": stable_years,
        "holm_adjusted_p": holm_p,
        "checks": checks,
        "passed": all(checks.values()),
        "interpretation": (
            "release-grade high historical conditional frequency"
            if all(checks.values())
            else "research/observation only; one or more predeclared gates failed"
        ),
    }


def analyze(
    securities: Sequence[Security],
    cache_dir: Path,
    prior_artifact: Path,
    output: Path,
) -> dict[str, Any]:
    prior_studied: set[str] = set()
    if prior_artifact.exists():
        prior_payload = json.loads(prior_artifact.read_text(encoding="utf-8"))
        prior_studied = set(prior_payload.get("universe", {}))

    controls_exact: dict[tuple[str, int, str], list[float]] = {}
    controls_coarse: dict[tuple[str, int, str], list[float]] = {}
    all_events: list[Event] = []
    quality_by_symbol: dict[str, dict[str, Any]] = {}
    for index, security in enumerate(securities, 1):
        events, quality = collect_security(
            security, cache_dir, prior_studied, controls_exact, controls_coarse
        )
        all_events.extend(events)
        quality_by_symbol[security.canonical] = quality
        if index % 100 == 0:
            print(
                f"analyze {index}/{len(securities)} events={len(all_events)} "
                f"controls={len(controls_exact)}",
                file=sys.stderr,
                flush=True,
            )

    events_by_signal: dict[str, list[Event]] = defaultdict(list)
    for event in all_events:
        events_by_signal[event.signal].append(event)
    reports = {
        definition.key: signal_report(
            events_by_signal.get(definition.key, []),
            definition,
            controls_exact,
            controls_coarse,
        )
        for definition in SIGNALS
    }

    raw_p_values: dict[str, float | None] = {}
    for key, report in reports.items():
        cluster = primary_summary(report).get("matched_direction_uplift_two_way_cluster")
        raw_p_values[key] = (
            float(cluster["one_sided_p_positive"])
            if isinstance(cluster, Mapping) and cluster.get("one_sided_p_positive") is not None
            else None
        )
    adjusted = holm_adjust(raw_p_values)
    gates = {
        key: release_gate(key, report, adjusted.get(key))
        for key, report in reports.items()
    }

    loaded = [item for item in quality_by_symbol.values() if item["status"] in {"loaded", "too_short"}]
    board_counts: dict[str, int] = defaultdict(int)
    current_board_counts: dict[str, int] = defaultdict(int)
    for security in securities:
        board_counts[security.board] += 1
        if security.current:
            current_board_counts[security.board] += 1
    fold_counts: dict[str, int] = defaultdict(int)
    for security in securities:
        fold_counts[symbol_fold(security.canonical, prior_studied)] += 1
    provider_counts: dict[str, int] = defaultdict(int)
    for item in loaded:
        provider_counts[str(item.get("provider") or "unknown")] += 1
    ledger = write_event_ledger(all_events, cache_dir)
    security_map = {item.canonical: item for item in securities}
    script_path = Path(__file__).resolve()
    payload: dict[str, Any] = {
        "metadata": {
            "study_version": STUDY_VERSION,
            "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
            "script_sha256": sha256_file(script_path),
            "provider": "mixed cached history: Sina houfuquan-derived, Tencent hfq, Eastmoney fqt=2",
            "adjustment": "back-adjusted/hfq",
            "liquidity_amount": "Tencent uses raw close * volume_in_hands * 100 proxy; Eastmoney uses reported amount",
            "frequency": "daily",
            "requested_start": START,
            "requested_end": END,
            "signal_clock": "all rules use the signal close and prior completed bars only",
            "entry_clock": "next tradable bar open; one-price estimated up-limit entries skipped",
            "horizon_convention": "H means signal+H close, entered signal+1 open; exactly H post-signal stock trading bars",
            "liquidity_filter": "prior-exclusive 20-bar median amount >= RMB 30m; RMB 50m is predeclared sensitivity",
            "minimum_listing_history": MIN_LISTED_BARS,
            "cost_model_for_buy_direction": {
                "commission_each_side": BUY_COMMISSION,
                "transfer_fee_each_side": TRANSFER_FEE,
                "stamp_duty_sell_only": SELL_STAMP_DUTY,
                "slippage_each_side": SLIPPAGE,
            },
            "sell_direction_semantics": "down-frequency/avoidance observation, not a short-sale strategy; raw underlying return is used",
            "selection_integrity": {
                "candidate_grid_frozen_before_expanded_market_evaluation": True,
                "previously_studied_249_symbols_forced_to_prior_studied_fold": True,
                "expanded_symbol_folds": "SHA256 deterministic 50% development / 30% validation / 20% test",
                "multiple_testing": "Holm family-wise 5% over each signal's predeclared primary horizon",
                "time_splits": "era/year summaries require exit date inside the period (purged boundary)",
            },
        },
        "universe": {
            "securities_requested": len(securities),
            "current_securities": sum(item.current for item in securities),
            "historical_noncurrent_securities": sum(not item.current for item in securities),
            "boards": dict(sorted(board_counts.items())),
            "current_boards": dict(sorted(current_board_counts.items())),
            "symbol_folds": dict(sorted(fold_counts.items())),
            "loaded_provider_files": dict(sorted(provider_counts.items())),
            "downloaded_or_cached": len(loaded),
            "analyzed_at_least_120_bars": sum(item["status"] == "loaded" for item in quality_by_symbol.values()),
            "too_short": sum(item["status"] == "too_short" for item in quality_by_symbol.values()),
            "missing": sum(item["status"] == "missing" for item in quality_by_symbol.values()),
            "raw_rows": sum(item.get("raw_rows", 0) for item in quality_by_symbol.values()),
            "valid_tradable_rows": sum(item.get("valid_rows", 0) for item in quality_by_symbol.values()),
            "rejected_nontradable_or_invalid_rows": sum(item.get("rejected_rows", 0) for item in quality_by_symbol.values()),
            "first_date": min(
                (item["first_date"] for item in loaded if item.get("first_date")),
                default=None,
            ),
            "last_date": max(
                (item["last_date"] for item in loaded if item.get("last_date")),
                default=None,
            ),
        },
        "source_validation": source_validation(security_map, cache_dir, prior_artifact),
        "event_ledger": ledger,
        "signal_definitions": [dataclasses.asdict(item) for item in SIGNALS],
        "primary_hypothesis_p_values": {
            key: {"raw_one_sided_p": raw_p_values[key], "holm_adjusted_p": adjusted[key]}
            for key in reports
        },
        "release_gates": gates,
        "signals": reports,
        "limitations": [
            "This is a retrospective event study. Existing data through 2026-08-20 have already informed adjacent research; it is not a pristine future holdout.",
            "The expanded-symbol cohort is a cross-sectional holdout relative to the earlier 249-symbol studies, but definitions still reflect general market knowledge.",
            "The history endpoints do not provide point-in-time ST names, raw adjustment factors, delisting returns, or order-book fill data.",
            "Shanghai/Shenzhen historical securities come from BaoStock stock basic; Beijing coverage is the current Hanai master, so delisted historical BSE names may be absent.",
            "Back-adjusted prices preserve local scale-free shapes but use adjustment information known later; raw-price limit checks are approximated from adjusted ratios.",
            "One-price up-limit checks model board/date rules but cannot reconstruct historical ST 5% limits, temporary IPO exemptions, or intraday queue availability.",
            "Same-day controls match board, prior drawdown/run-up and liquidity tier; observational matching reduces confounding but does not establish causality.",
            "Signals are de-duplicated per symbol and signal stage; overlapping market-wide events remain correlated and are handled approximately with stock/month two-way clustering.",
            "Historical conditional frequency, even when statistically stable, cannot guarantee future profits and is sensitive to regime, costs and implementation.",
        ],
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + f".{os.getpid()}.tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(output)
    print(f"wrote {output}", file=sys.stderr, flush=True)
    return payload


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("universe", "download", "analyze", "all"), nargs="?", default="all")
    parser.add_argument("--cache-dir", type=Path, default=DEFAULT_CACHE)
    parser.add_argument("--database", type=Path, default=DEFAULT_DB)
    parser.add_argument("--prior-artifact", type=Path, default=DEFAULT_PRIOR)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--workers", type=int, default=16)
    parser.add_argument("--provider", choices=("auto", "eastmoney", "tencent", "sina"), default="auto")
    parser.add_argument("--refresh-universe", action="store_true")
    parser.add_argument("--refresh", action="store_true", help="redownload existing K-line cache files")
    parser.add_argument("--max-symbols", type=int, default=None, help="diagnostic subset only")
    parser.add_argument("--exchange", choices=("SH", "SZ", "BJ"), default=None, help="diagnostic/source-recovery subset")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.workers < 1 or args.workers > 64:
        raise ValueError("workers must be between 1 and 64")
    universe_path = args.cache_dir / "universe.json"
    securities = build_universe(args.database, universe_path, args.refresh_universe)
    if args.exchange is not None:
        securities = [item for item in securities if item.exchange == args.exchange]
    if args.max_symbols is not None:
        securities = securities[: args.max_symbols]
        print(
            "WARNING: --max-symbols creates a diagnostic subset, not full-market evidence",
            file=sys.stderr,
        )
    print(
        f"universe securities={len(securities)} current={sum(item.current for item in securities)}",
        file=sys.stderr,
        flush=True,
    )
    if args.mode == "universe":
        return 0
    if args.mode in {"download", "all"}:
        manifest = download_all(
            securities, args.cache_dir, args.refresh, args.workers, args.provider
        )
        failures = sum(item["status"] == "failed" for item in manifest["results"])
        if failures:
            print(f"download failures={failures}; analysis will disclose missing coverage", file=sys.stderr)
        if args.mode == "download":
            return 1 if failures else 0
    analyze(securities, args.cache_dir, args.prior_artifact, args.output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
