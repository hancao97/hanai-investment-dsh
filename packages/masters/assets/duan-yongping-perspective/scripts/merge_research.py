#!/usr/bin/env python3
"""
合并6个Agent的调研结果，生成Phase 1.5调研Review检查点的摘要表格。
扫描 references/research/ 目录下的01-06 md文件，统计每个维度的来源数量、
一手/二手占比、关键发现。

用法:
    python3 merge_research.py <skill目录路径>

示例:
    python3 merge_research.py .claude/skills/elon-musk-perspective

输出: 打印markdown格式的摘要表格到stdout
"""

import re
import sys
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

AGENTS = {
    '01-writings': '著作',
    '02-conversations': '对话',
    '03-expression-dna': '表达',
    '04-external-views': '他者',
    '05-decisions': '决策',
    '06-timeline': '时间线',
}


URL_RE = re.compile(r'https?://[^\s)>\]"\';；，。]+')
PRIMARY_RE = re.compile(
    r'一手|本人原话|本人直接产出|本人认证|现场问答|'
    r'原始(?:访谈|演讲|文件|记录|材料|披露|页面|账号|视频)|'
    r'(?<![A-Z0-9])P[12](?![A-Z0-9])|primary',
    re.IGNORECASE,
)
SECONDARY_RE = re.compile(
    r'二手|整理者|编选|转述|外部评价|评论|分析|'
    r'(?<![A-Z0-9])S[12](?![A-Z0-9])|secondary',
    re.IGNORECASE,
)
TRACKING_PARAMS = {'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'spm'}


def canonicalize_url(url: str) -> str:
    """Remove fragments and common tracking parameters before deduplication."""
    url = url.rstrip('.,;:，。；：')
    parts = urlsplit(url)
    query = [(key, value) for key, value in parse_qsl(parts.query, keep_blank_values=True)
             if key.lower() not in TRACKING_PARAMS]
    return urlunsplit((parts.scheme.lower(), parts.netloc.lower(), parts.path.rstrip('/'),
                       urlencode(query), ''))


def discover_local_sources(skill_dir: Path) -> set[str]:
    source_dir = skill_dir / 'references' / 'sources'
    if not source_dir.exists():
        return set()
    return {path.name for path in source_dir.rglob('*') if path.is_file()}


def classify_source(line: str) -> str:
    primary = bool(PRIMARY_RE.search(line))
    secondary = bool(SECONDARY_RE.search(line))
    if primary == secondary:
        return 'unknown'
    return 'primary' if primary else 'secondary'


def count_sources(content: str, local_basenames: set[str]) -> dict:
    """Count unique cited sources, not mentions or marker words."""
    sources: dict[str, set[str]] = {}

    for line in content.splitlines():
        source_ids = {canonicalize_url(url) for url in URL_RE.findall(line)}
        source_ids.update(f'local:{name}' for name in local_basenames if name in line)
        source_type = classify_source(line)
        for source_id in source_ids:
            sources.setdefault(source_id, set()).add(source_type)

    primary = set()
    secondary = set()
    unknown = set()
    for source_id, labels in sources.items():
        labels.discard('unknown')
        if labels == {'primary'}:
            primary.add(source_id)
        elif labels == {'secondary'}:
            secondary.add(source_id)
        else:
            unknown.add(source_id)

    return {
        'sources': set(sources),
        'primary': primary,
        'secondary': secondary,
        'unknown': unknown,
    }


def extract_key_findings(content: str, max_items: int = 3) -> list[str]:
    """提取关键发现（取前几个二级标题或加粗项）"""
    # 尝试提取##标题
    headings = re.findall(r'^##\s+(.+)$', content, re.MULTILINE)
    if headings:
        return headings[:max_items]

    # fallback: 提取加粗项
    bolds = re.findall(r'\*\*(.+?)\*\*', content)
    if bolds:
        return bolds[:max_items]

    # fallback: 取前3个非空行
    lines = [l.strip() for l in content.split('\n') if l.strip() and not l.startswith('#')]
    return [l[:50] + '...' if len(l) > 50 else l for l in lines[:max_items]]


def extract_section_items(content: str, heading_pattern: str) -> list[str]:
    """Extract bullets only from explicitly named sections."""
    match = re.search(
        rf'^#{{1,4}}\s+[^\n]*(?:{heading_pattern})[^\n]*\n(.*?)(?=^#{{1,4}}\s+|\Z)',
        content,
        re.MULTILINE | re.DOTALL | re.IGNORECASE,
    )
    if not match:
        return []
    items = re.findall(r'^\s*(?:[-*]|\d+[.)])\s+(.+)$', match.group(1), re.MULTILINE)
    return [re.sub(r'\s+', ' ', item).strip() for item in items if item.strip()]


def find_contradictions(files: dict[str, str]) -> list[str]:
    contradictions = []
    for name, content in files.items():
        for item in extract_section_items(content, r'矛盾|冲突|争议'):
            contradictions.append(f"{AGENTS.get(name, name)}: {item[:120]}")
    return contradictions


def main():
    if len(sys.argv) < 2:
        print("用法: python3 merge_research.py <skill目录路径>")
        sys.exit(1)

    skill_dir = Path(sys.argv[1])
    research_dir = skill_dir / 'references' / 'research'

    if not research_dir.exists():
        print(f"❌ 目录不存在: {research_dir}")
        sys.exit(1)

    files = {}
    rows = []
    local_basenames = discover_local_sources(skill_dir)
    all_sources = set()
    all_primary = set()
    all_secondary = set()
    all_unknown = set()
    missing = []

    for key, label in AGENTS.items():
        md_file = research_dir / f"{key}.md"
        if not md_file.exists():
            missing.append(label)
            rows.append(f"│ {label:<12} │ {'❌ 缺失':<8} │ {'—':<24} │")
            continue

        content = md_file.read_text(encoding='utf-8')
        files[key] = content
        stats = count_sources(content, local_basenames)
        findings = extract_key_findings(content)

        all_sources.update(stats['sources'])
        all_primary.update(stats['primary'])
        all_secondary.update(stats['secondary'])
        all_unknown.update(stats['unknown'])

        findings_str = ', '.join(findings) if findings else '—'
        if len(findings_str) > 40:
            findings_str = findings_str[:37] + '...'

        rows.append(f"│ {label:<12} │ {len(stats['sources']):<8} │ {findings_str:<24} │")

    # 矛盾检测
    contradictions = find_contradictions(files)

    # 输出
    print("┌──────────────┬──────────┬──────────────────────────┐")
    print("│ Agent        │ 来源数量  │ 关键发现                  │")
    print("├──────────────┼──────────┼──────────────────────────┤")
    for row in rows:
        print(row)
    print("├──────────────┼──────────┼──────────────────────────┤")

    # A source cited with conflicting classifications is not counted as primary.
    conflicts = all_primary & all_secondary
    all_primary -= conflicts
    all_secondary -= conflicts
    all_unknown.update(conflicts)
    all_unknown -= all_primary | all_secondary
    classified_total = len(all_primary) + len(all_secondary)
    if classified_total:
        ratio = len(all_primary) / classified_total
        primary_ratio = f"{len(all_primary)}/{classified_total} ({ratio:.0%}); 未分类{len(all_unknown)}"
    else:
        primary_ratio = f"需人工核验; 未分类{len(all_unknown)}"
    print(f"│ 全局唯一来源   │ {len(all_sources):<8} │ 一手占比: {primary_ratio:<15} │")

    if contradictions:
        print(f"│ 矛盾点        │ {len(contradictions)}处      │ {contradictions[0][:24]:<24} │")
    else:
        print(f"│ 矛盾点        │ 0处      │ {'—':<24} │")

    if missing:
        print(f"│ 信息不足维度   │ {len(missing)}个      │ {', '.join(missing):<24} │")
    else:
        print(f"│ 信息不足维度   │ 无       │ {'—':<24} │")

    print("└──────────────┴──────────┴──────────────────────────┘")

    # 总结
    if len(all_sources) < 10:
        print("\n⚠️ 总来源数 <10，建议降低期望或补充调研")
    if all_unknown:
        print(f"\n⚠️ {len(all_unknown)}个来源未明确分类；一手占比不把它们计入分母，需人工复核")
    if missing:
        print(f"\n⚠️ 缺失维度: {', '.join(missing)}，建议补充或在诚实边界中标注")


if __name__ == '__main__':
    main()
