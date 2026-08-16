#!/usr/bin/env python3
"""
自动检查生成的SKILL.md是否通过Phase 4质量标准。
对照通过标准表格逐项检查，输出通过/不通过和具体原因。

用法:
    python3 quality_check.py <SKILL.md路径>

示例:
    python3 quality_check.py .claude/skills/elon-musk-perspective/SKILL.md
"""

import sys
import re
from pathlib import Path


def extract_section(content: str, heading_pattern: str, level: int = 2) -> str | None:
    heading = re.escape('#' * level)
    match = re.search(
        rf'^{heading}\s+[^\n]*(?:{heading_pattern})[^\n]*\n(.*?)(?=^{heading}\s+|\Z)',
        content,
        re.MULTILINE | re.DOTALL | re.IGNORECASE,
    )
    return match.group(1) if match else None


def extract_h3_blocks(section: str) -> list[tuple[str, str]]:
    matches = list(re.finditer(r'^###\s+(.+)$', section, re.MULTILINE))
    blocks = []
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(section)
        blocks.append((match.group(1).strip(), section[match.end():end]))
    return blocks


def check_mental_models(content: str) -> tuple[bool, str]:
    """检查模型数量，并逐个验证证据、应用和局限。"""
    section = extract_section(content, r'核心心智模型|心智模型|Mental Models?')
    if section is None:
        return False, "未检测到心智模型section"

    models = extract_h3_blocks(section)
    count = len(models)
    bad = []
    for title, body in models:
        missing = []
        if not re.search(r'证据|来源|案例|evidence', body, re.IGNORECASE):
            missing.append('证据')
        if not re.search(r'应用|使用|何时|application', body, re.IGNORECASE):
            missing.append('应用')
        if not re.search(r'局限|失效|不适用|盲区|limitation|blind spot', body, re.IGNORECASE):
            missing.append('局限')
        if missing:
            bad.append(f"{title}缺{'+'.join(missing)}")

    passed = 3 <= count <= 7 and not bad
    detail = f"{count}个心智模型"
    if not 3 <= count <= 7:
        detail += "；数量应为3-7个"
    if bad:
        detail += "；" + "；".join(bad[:3])
    return passed, detail


def check_limitations(content: str) -> tuple[bool, str]:
    """单独报告逐模型局限覆盖率。"""
    section = extract_section(content, r'核心心智模型|心智模型|Mental Models?')
    if section is None:
        return False, "未检测到心智模型section"
    models = extract_h3_blocks(section)
    covered = sum(bool(re.search(r'局限|失效|不适用|盲区|limitation|blind spot', body,
                                    re.IGNORECASE)) for _, body in models)
    passed = bool(models) and covered == len(models)
    return passed, f"逐模型局限覆盖: {covered}/{len(models)}"


def check_expression_dna(content: str) -> tuple[bool, str]:
    """检查表达DNA辨识度"""
    section = extract_section(content, r'表达\s*DNA|Expression DNA|表达风格')
    if section is None:
        return False, "未找到表达DNA section"
    dimensions = {marker for marker in ('句式', '词汇', '语气', '幽默', '节奏', '确定性', '引用', '口头禅')
                  if marker in section}
    rules = re.findall(r'^\s*[-*]\s+', section, re.MULTILINE)
    passed = len(dimensions) >= 3 and len(rules) >= 3
    return passed, f"表达DNA维度: {len(dimensions)}；可执行规则: {len(rules)}"


def check_honest_boundary(content: str) -> tuple[bool, str]:
    """检查诚实边界（至少3条）"""
    # 找诚实边界section
    boundary_match = re.search(r'(?:##\s+.*诚实边界|## Honest Boundary)(.*?)(?=\n##\s|\Z)', content, re.DOTALL | re.IGNORECASE)
    if not boundary_match:
        return False, "❌ 未找到诚实边界section"

    boundary_text = boundary_match.group(1)
    # 计算列表项
    items = re.findall(r'^[-*]\s+', boundary_text, re.MULTILINE)
    count = len(items)
    passed = count >= 3
    return passed, f"诚实边界: {count}条 {'✅' if passed else '❌ (应≥3条)'}"


def check_tensions(content: str) -> tuple[bool, str]:
    """检查内在张力（至少2对）"""
    section = extract_section(content, r'内在张力|核心张力|矛盾与张力|Tensions?|Paradoxes?')
    if section is None:
        return False, "未找到独立的内在张力section"
    items = re.findall(r'^\s*(?:[-*]|\d+[.)])\s+', section, re.MULTILINE)
    passed = len(items) >= 2
    return passed, f"内在张力: {len(items)}对"


def check_primary_sources(content: str) -> tuple[bool, str]:
    """检查一手来源占比"""
    source_section = extract_section(content, r'调研来源|来源|Sources?|References?')
    if source_section is None:
        return False, "未找到来源section"

    primary_section = extract_section(source_section, r'一手来源|Primary', level=3)
    secondary_section = extract_section(source_section, r'二手来源|Secondary', level=3)
    if primary_section is None or secondary_section is None:
        return False, "来源没有分成一手/二手两个列表"

    primary_items = re.findall(r'^\s*[-*]\s+(.+)$', primary_section, re.MULTILINE)
    secondary_items = re.findall(r'^\s*[-*]\s+(.+)$', secondary_section, re.MULTILINE)
    primary = len(set(item.strip() for item in primary_items))
    secondary = len(set(item.strip() for item in secondary_items))
    total = primary + secondary
    if total == 0:
        return False, "来源列表为空"

    ratio = primary / total
    passed = ratio > 0.5
    return passed, f"一手来源占比: {primary}/{total} ({ratio:.0%})"


def main():
    if len(sys.argv) < 2:
        print("用法: python3 quality_check.py <SKILL.md路径>")
        sys.exit(1)

    skill_path = Path(sys.argv[1])
    if not skill_path.exists():
        print(f"❌ 文件不存在: {skill_path}")
        sys.exit(1)

    content = skill_path.read_text(encoding='utf-8')

    checks = [
        ("心智模型数量", check_mental_models),
        ("模型局限性", check_limitations),
        ("表达DNA辨识度", check_expression_dna),
        ("诚实边界", check_honest_boundary),
        ("内在张力", check_tensions),
        ("一手来源占比", check_primary_sources),
    ]

    print(f"质量检查: {skill_path.name}")
    print("=" * 50)

    passed_count = 0
    total = len(checks)

    for name, check_fn in checks:
        passed, detail = check_fn(content)
        status = "✅ PASS" if passed else "❌ FAIL"
        print(f"  {name:<12} {status}  {detail}")
        if passed:
            passed_count += 1

    print("=" * 50)
    print(f"结果: {passed_count}/{total} 通过")

    if passed_count == total:
        print("🎉 全部通过，可以交付")
    elif passed_count >= total - 1:
        print("⚠️ 基本通过，建议修复不通过项后交付")
    else:
        print("❌ 多项不通过，建议回到Phase 2迭代")

    sys.exit(0 if passed_count == total else 1)


if __name__ == '__main__':
    main()
