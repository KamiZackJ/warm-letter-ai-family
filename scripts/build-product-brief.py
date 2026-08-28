"""Build the controlled, stage-version product brief for internal review.

The script reads only the already-controlled CASE-001 package. It does not
copy the original photo, the source transcript, or any source directory path
into the PDF.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
from typing import Any

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    HRFlowable,
    Image,
    KeepTogether,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)


PAGE_WIDTH, PAGE_HEIGHT = A4
INK = colors.HexColor("#16343D")
INK_SOFT = colors.HexColor("#496068")
VERMILION = colors.HexColor("#A84636")
VERMILION_SOFT = colors.HexColor("#F4E1DC")
SAGE = colors.HexColor("#2E6B5B")
SAGE_SOFT = colors.HexColor("#E4F0EB")
GOLD = colors.HexColor("#C18B3A")
PAPER = colors.HexColor("#FAF7F0")
PAPER_DEEP = colors.HexColor("#EFE8DA")
LINE = colors.HexColor("#C9D2CC")
WHITE = colors.white


def register_fonts() -> tuple[str, str]:
    """Prefer Windows Chinese fonts, then use ReportLab's CJK fallback."""

    regular = Path(r"C:\Windows\Fonts\Deng.ttf")
    bold = Path(r"C:\Windows\Fonts\Dengb.ttf")
    if regular.exists() and bold.exists():
        pdfmetrics.registerFont(TTFont("WarmDeng", str(regular)))
        pdfmetrics.registerFont(TTFont("WarmDengBold", str(bold)))
        return "WarmDeng", "WarmDengBold"

    from reportlab.pdfbase.cidfonts import UnicodeCIDFont

    pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
    return "STSong-Light", "STSong-Light"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def load_package(package_root: Path) -> tuple[dict[str, Any], dict[str, Any], Path]:
    manifest_path = package_root / "manifest.json"
    case_path = package_root / "demo-case.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    case_data = json.loads(case_path.read_text(encoding="utf-8"))
    photo_path = package_root / "media" / "case-001-photo-crop.jpg"
    if not photo_path.is_file():
        raise FileNotFoundError(f"Controlled photo is missing: {photo_path}")
    expected_photo_hash = manifest["outputs"]["photo"]["sha256"]
    if sha256(photo_path) != expected_photo_hash:
        raise ValueError("Controlled photo hash does not match manifest")
    return manifest, case_data, photo_path


def esc(value: Any) -> str:
    return str(value).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def make_styles(regular: str, bold: str) -> dict[str, ParagraphStyle]:
    base = getSampleStyleSheet()
    return {
        "body": ParagraphStyle(
            "body",
            parent=base["BodyText"],
            fontName=regular,
            fontSize=9.5,
            leading=15,
            textColor=INK_SOFT,
            spaceAfter=5,
        ),
        "small": ParagraphStyle(
            "small",
            parent=base["BodyText"],
            fontName=regular,
            fontSize=7.8,
            leading=11.5,
            textColor=INK_SOFT,
            spaceAfter=2,
        ),
        "tiny": ParagraphStyle(
            "tiny",
            parent=base["BodyText"],
            fontName=regular,
            fontSize=6.8,
            leading=9.2,
            textColor=INK_SOFT,
            spaceAfter=1,
        ),
        "kicker": ParagraphStyle(
            "kicker",
            parent=base["BodyText"],
            fontName=bold,
            fontSize=7.2,
            leading=10,
            textColor=VERMILION,
            tracking=1.2,
            spaceAfter=5,
        ),
        "h1": ParagraphStyle(
            "h1",
            parent=base["Heading1"],
            fontName=bold,
            fontSize=31,
            leading=37,
            textColor=INK,
            spaceAfter=7,
        ),
        "h2": ParagraphStyle(
            "h2",
            parent=base["Heading2"],
            fontName=bold,
            fontSize=19,
            leading=25,
            textColor=INK,
            spaceBefore=2,
            spaceAfter=7,
        ),
        "h3": ParagraphStyle(
            "h3",
            parent=base["Heading3"],
            fontName=bold,
            fontSize=11.5,
            leading=16,
            textColor=INK,
            spaceAfter=4,
        ),
        "hero": ParagraphStyle(
            "hero",
            parent=base["BodyText"],
            fontName=regular,
            fontSize=13,
            leading=20,
            textColor=INK_SOFT,
            spaceAfter=9,
        ),
        "quote": ParagraphStyle(
            "quote",
            parent=base["BodyText"],
            fontName=regular,
            fontSize=11,
            leading=18,
            textColor=INK,
            leftIndent=10,
            borderColor=VERMILION,
            borderWidth=0.8,
            borderPadding=8,
            spaceAfter=7,
        ),
        "table_head": ParagraphStyle(
            "table_head",
            parent=base["BodyText"],
            fontName=bold,
            fontSize=8,
            leading=10,
            textColor=WHITE,
        ),
        "table_head_center": ParagraphStyle(
            "table_head_center",
            parent=base["BodyText"],
            fontName=bold,
            fontSize=8.3,
            leading=10.5,
            alignment=TA_CENTER,
            textColor=WHITE,
        ),
        "table": ParagraphStyle(
            "table",
            parent=base["BodyText"],
            fontName=regular,
            fontSize=7.6,
            leading=10.5,
            textColor=INK_SOFT,
        ),
        "table_bold": ParagraphStyle(
            "table_bold",
            parent=base["BodyText"],
            fontName=bold,
            fontSize=7.8,
            leading=10.5,
            textColor=INK,
        ),
        "center": ParagraphStyle(
            "center",
            parent=base["BodyText"],
            fontName=regular,
            fontSize=8.2,
            leading=11,
            alignment=TA_CENTER,
            textColor=INK_SOFT,
        ),
        "center_bold": ParagraphStyle(
            "center_bold",
            parent=base["BodyText"],
            fontName=bold,
            fontSize=13,
            leading=16,
            alignment=TA_CENTER,
            textColor=INK,
        ),
        "right": ParagraphStyle(
            "right",
            parent=base["BodyText"],
            fontName=regular,
            fontSize=7.2,
            leading=10,
            alignment=TA_RIGHT,
            textColor=INK_SOFT,
        ),
    }


def p(text: str, style: ParagraphStyle) -> Paragraph:
    return Paragraph(text, style)


def section_header(styles: dict[str, ParagraphStyle], number: str, title: str, note: str) -> list[Any]:
    return [
        p(f"{number} / 阶段说明书", styles["kicker"]),
        p(title, styles["h2"]),
        p(note, styles["body"]),
        Spacer(1, 3 * mm),
    ]


def info_card(styles: dict[str, ParagraphStyle], title: str, body: str, tint: colors.Color = WHITE) -> Table:
    content = [p(title, styles["h3"]), p(body, styles["small"])]
    table = Table([[content]], colWidths=[55 * mm])
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), tint),
                ("BOX", (0, 0), (-1, -1), 0.6, LINE),
                ("LEFTPADDING", (0, 0), (-1, -1), 10),
                ("RIGHTPADDING", (0, 0), (-1, -1), 10),
                ("TOPPADDING", (0, 0), (-1, -1), 9),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
            ]
        )
    )
    return table


def status_table(styles: dict[str, ParagraphStyle], rows: list[tuple[str, str, str]]) -> Table:
    data = [[p("项目", styles["table_head"]), p("状态", styles["table_head"]), p("说明", styles["table_head"])]]
    for item, status, detail in rows:
        status_style = styles["table_bold"]
        data.append([p(esc(item), styles["table_bold"]), p(esc(status), status_style), p(esc(detail), styles["table"])])
    table = Table(data, colWidths=[38 * mm, 25 * mm, 112 * mm], repeatRows=1)
    commands: list[tuple[Any, ...]] = [
        ("BACKGROUND", (0, 0), (-1, 0), INK),
        ("GRID", (0, 0), (-1, -1), 0.45, LINE),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 7),
        ("RIGHTPADDING", (0, 0), (-1, -1), 7),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]
    for row_index, (_, status, _) in enumerate(rows, start=1):
        commands.append(("BACKGROUND", (0, row_index), (-1, row_index), SAGE_SOFT if status in {"PASS", "已接入", "已完成"} else VERMILION_SOFT))
        if status in {"待取证", "待开始", "待补交", "未完成"}:
            commands.append(("TEXTCOLOR", (1, row_index), (1, row_index), VERMILION))
    table.setStyle(TableStyle(commands))
    return table


def flow_step(styles: dict[str, ParagraphStyle], index: str, title: str, detail: str) -> list[Any]:
    return [p(index, styles["kicker"]), p(title, styles["h3"]), p(detail, styles["small"])]


def draw_page(canvas: Any, doc: SimpleDocTemplate) -> None:
    canvas.saveState()
    canvas.setFillColor(PAPER)
    canvas.rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT, fill=1, stroke=0)
    canvas.setStrokeColor(LINE)
    canvas.setLineWidth(0.45)
    canvas.line(doc.leftMargin, PAGE_HEIGHT - 18 * mm, PAGE_WIDTH - doc.rightMargin, PAGE_HEIGHT - 18 * mm)
    canvas.setFont("WarmDeng", 7.2)
    canvas.setFillColor(INK_SOFT)
    canvas.drawString(doc.leftMargin, PAGE_HEIGHT - 13 * mm, "暖笺 / AI产品说明书 / 阶段版")
    canvas.drawRightString(PAGE_WIDTH - doc.rightMargin, PAGE_HEIGHT - 13 * mm, "CASE-001 · G0 · 内部受控")
    canvas.line(doc.leftMargin, 14 * mm, PAGE_WIDTH - doc.rightMargin, 14 * mm)
    canvas.drawString(doc.leftMargin, 9 * mm, "真实队友素材已做隐私裁切；本文件不代表真实 OpenAI、微信双真机或生产放行。")
    canvas.drawRightString(PAGE_WIDTH - doc.rightMargin, 9 * mm, f"{canvas.getPageNumber():02d}")
    canvas.restoreState()


def build_pdf(package_root: Path, output_path: Path) -> None:
    manifest, case_data, photo_path = load_package(package_root)
    regular, bold = register_fonts()
    styles = make_styles(regular, bold)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    document = SimpleDocTemplate(
        str(output_path),
        pagesize=A4,
        rightMargin=18 * mm,
        leftMargin=18 * mm,
        topMargin=24 * mm,
        bottomMargin=20 * mm,
        title="暖笺 AI产品说明书 阶段版",
        author="暖笺团队",
        subject="CASE-001 受控团队成果与参赛产品设计",
    )
    story: list[Any] = []

    source_integrity = manifest["sourceIntegrity"]
    output_photo = manifest["outputs"]["photo"]
    output_audio = manifest["outputs"]["audio"]
    test_ids = "、".join(case_data.get("safetyTests", ["T01", "T02", "T03", "T04", "T05", "T06", "T07"]))

    # Page 1: cover and actual material proof.
    story.extend(
        [
            p("WARM LETTER / PRODUCT BRIEF / 2026.08.28", styles["kicker"]),
            p("暖笺", styles["h1"]),
            p("把今天，写给想念的人。", styles["h2"]),
            p("一款面向异地家庭的多模态 AI 家书工具：用户主动选择生活素材，AI 组织成可核对的家书草稿；本人确认后，家人才能阅读、播放原始语音并回复。", styles["hero"]),
        ]
    )
    photo = Image(str(photo_path), width=61 * mm, height=86 * mm)
    cover_text = [
        p("阶段交付结论", styles["kicker"]),
        p("队友真实材料已经进入一条可操作的产品旅程。", styles["h3"]),
        p("本说明书以队友 CASE-001 为实际素材证据，展示产品定位、AI 价值、工程承接、隐私边界和参赛发布计划。", styles["body"]),
        p("当前等级：G0 队内开发演示可用", styles["h3"]),
        p("固定审核稿，不调用实时 OpenAI；原始照片不进入可转发包。", styles["small"]),
    ]
    cover_table = Table([[cover_text, photo]], colWidths=[105 * mm, 65 * mm])
    cover_table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (0, 0), WHITE),
                ("BACKGROUND", (1, 0), (1, 0), PAPER_DEEP),
                ("BOX", (0, 0), (-1, -1), 0.6, LINE),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 12),
                ("RIGHTPADDING", (0, 0), (-1, -1), 12),
                ("TOPPADDING", (0, 0), (-1, -1), 12),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 12),
            ]
        )
    )
    story.extend([cover_table, Spacer(1, 9 * mm)])
    metrics = [
        [p("355/355", styles["center_bold"]), p("7/7 PASS", styles["center_bold"]), p("720×1020", styles["center_bold"]), p("8.895s", styles["center_bold"])],
        [p("本地自动回归", styles["center"]), p("内容安全验收", styles["center"]), p("照片物理裁切", styles["center"]), p("队友原始 m4a", styles["center"])],
    ]
    metrics_table = Table(metrics, colWidths=[42.5 * mm] * 4)
    metrics_table.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), SAGE_SOFT), ("BOX", (0, 0), (-1, -1), 0.6, LINE), ("INNERGRID", (0, 0), (-1, -1), 0.4, LINE), ("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("TOPPADDING", (0, 0), (-1, -1), 8), ("BOTTOMPADDING", (0, 0), (-1, -1), 8)]))
    story.extend([metrics_table, Spacer(1, 7 * mm), p("队友素材核验", styles["kicker"]), p(f"照片来源哈希：{source_integrity['photo']['sha256'][:16]}...；裁切图哈希：{output_photo['sha256'][:16]}...。语音来源与受控包内输出逐字节一致：{output_audio['sha256'][:16]}...。", styles["small"]), PageBreak()])

    # Page 2: users, problem and scenarios.
    story.extend(section_header(styles, "01", "先解决“想说，但只剩一句挺好的”", "产品把异地家庭沟通中的素材整理、表达和回复连成一次低压力的日常动作。"))
    audience = [
        [p("目标用户", styles["table_head"]), p("真实任务", styles["table_head"]), p("设计响应", styles["table_head"])],
        [p("异地生活的年轻寄信人", styles["table_bold"]), p("想分享小事，但没有时间组织成完整家书", styles["table"]), p("主动挑选素材；三版长度；编辑后再确认", styles["table"])],
        [p("希望被看见的父母/长辈", styles["table_bold"]), p("需要简单打开、看清文字、听到原音并回复", styles["table"]), p("H5 大字模式；系统朗读；原始 m4a；一键回复", styles["table"])],
        [p("团队和评审", styles["table_bold"]), p("要判断 AI 是否真的解决问题，而不是看静态截图", styles["table"]), p("来源映射、确认快照、异常边界和可复核证据", styles["table"])],
    ]
    audience_table = Table(audience, colWidths=[42 * mm, 60 * mm, 68 * mm], repeatRows=1)
    audience_table.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, 0), INK), ("BACKGROUND", (0, 1), (-1, -1), WHITE), ("GRID", (0, 0), (-1, -1), 0.45, LINE), ("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 7), ("RIGHTPADDING", (0, 0), (-1, -1), 7), ("TOPPADDING", (0, 0), (-1, -1), 7), ("BOTTOMPADDING", (0, 0), (-1, -1), 7)]))
    story.extend([audience_table, Spacer(1, 8 * mm), p("三个可推广的高频场景", styles["kicker"])])
    cards = [[info_card(styles, "日常报平安", "下班、吃饭、路上看到的小事，快速整理成一封轻量家书。", WHITE), info_card(styles, "节日与纪念日", "从照片、语音和文字中抽取共同记忆，再由本人确认语气和内容。", VERMILION_SOFT), info_card(styles, "低频但重要的沟通", "异地求学、工作或照护关系中，用可追溯的素材减少误解。", SAGE_SOFT)]]
    # Keep the cards on one row while allowing the body to wrap naturally.
    cards[0][1] = info_card(styles, "节日与纪念日", "从照片、语音和文字中抽取共同记忆，再由本人确认语气和内容。", VERMILION_SOFT)
    cards[0][2] = info_card(styles, "低频但重要的沟通", "异地求学、工作或照护关系中，用可追溯的素材减少误解。", SAGE_SOFT)
    cards_table = Table(cards, colWidths=[57 * mm, 57 * mm, 57 * mm])
    cards_table.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 3)]))
    story.append(cards_table)
    story.extend([Spacer(1, 7 * mm), p("设计原则", styles["kicker"]), p("不读取完整相册或聊天记录；每项素材由用户主动选择。对不清楚的细节使用上位词，不把照片中的商品推导为购买、食用或功效，也不识别画面中的无关人物。", styles["quote"]), PageBreak()])

    # Page 3: product flow.
    story.extend(section_header(styles, "02", "一封家书的完整闭环", "演示和未来产品都围绕同一条链路：主动选择、结构化整理、来源核对、本人确认、家人阅读与回复。"))
    flow = [
        [flow_step(styles, "01", "主动选择素材", "照片、语音、文字由寄信人逐项勾选；未选择的内容不进入本次整理。"), flow_step(styles, "02", "生成可编辑草稿", "AI 以结构化段落输出事实、语气和 sourceRefs，避免一段话无法核对。"), flow_step(styles, "03", "编辑与来源核对", "改写或新增内容会清空旧引用，必须重新选择来源或标记为本人补充。")],
        [flow_step(styles, "04", "确认快照", "标题、正文、署名和媒体关联冻结为确认稿快照；后续草稿变化不影响收信端。"), flow_step(styles, "05", "阅读与回复", "家人可切换字号、查看段落来源、播放原始语音并提交安全校验后的回复。"), flow_step(styles, "06", "可撤销分享", "真实服务使用短期读信/媒体凭据，支持过期、撤销、重签、限流和幂等。")],
    ]
    flow_table = Table(flow, colWidths=[57 * mm, 57 * mm, 57 * mm], rowHeights=[42 * mm, 42 * mm])
    flow_table.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), WHITE), ("BOX", (0, 0), (-1, -1), 0.6, LINE), ("INNERGRID", (0, 0), (-1, -1), 0.45, LINE), ("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 9), ("RIGHTPADDING", (0, 0), (-1, -1), 9), ("TOPPADDING", (0, 0), (-1, -1), 8), ("BOTTOMPADDING", (0, 0), (-1, -1), 8)]))
    story.extend([flow_table, Spacer(1, 8 * mm), p("CASE-001 在这条链路中的实际呈现", styles["kicker"]), p("左侧显示队友提供的物理裁切照片和原始 m4a；中间载入 A/B/C 三版固定审核稿；确认后进入本地阅读端，展示同一版本的正文、来源、语音和回复。", styles["body"])])
    flow_evidence = [[p("队友材料", styles["table_head"]), p("本项目承接", styles["table_head"]), p("当前边界", styles["table_head"])], [p("照片 / 语音 / A-B-C", styles["table_bold"]), p("受控包、React H5、离线交互、段落级 sourceRefs", styles["table"]), p("固定审核稿，不冒充实时模型输出", styles["table"])], [p("隐私审查 / T01-T07", styles["table_bold"]), p("构建门禁、页面披露、来源证据和交接清单", styles["table"]), p("自动验收不等于真人测试", styles["table"])]]
    flow_evidence_table = Table(flow_evidence, colWidths=[45 * mm, 67 * mm, 59 * mm], repeatRows=1)
    flow_evidence_table.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, 0), INK), ("GRID", (0, 0), (-1, -1), 0.45, LINE), ("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 7), ("RIGHTPADDING", (0, 0), (-1, -1), 7), ("TOPPADDING", (0, 0), (-1, -1), 6), ("BOTTOMPADDING", (0, 0), (-1, -1), 6)]))
    story.extend([flow_evidence_table, PageBreak()])

    # Page 4: AI value and safety.
    story.extend(section_header(styles, "03", "AI 的核心价值不是代写，而是把多模态事实变成可核对表达", "参赛方向固定为 AI 产品实现；真实演示必须证明 AI 直接理解素材并影响产品结果。"))
    ai_cards = [[info_card(styles, "理解", "图片/截图提取可见事实；语音转写或理解日常情绪；文字提供上下文。", SAGE_SOFT), info_card(styles, "组织", "将事实、时间、语气和收信人偏好整理为结构化段落，而不是一段不可追溯的长文。", WHITE), info_card(styles, "转换", "同一事实生成短笺、日常、留白三种表达，服务不同阅读负担。", VERMILION_SOFT)]]
    ai_cards[0][1] = info_card(styles, "组织", "将事实、时间、语气和收信人偏好整理为结构化段落，而不是一段不可追溯的长文。", WHITE)
    ai_cards[0][2] = info_card(styles, "转换", "同一事实生成短笺、日常、留白三种表达，服务不同阅读负担。", VERMILION_SOFT)
    ai_table = Table(ai_cards, colWidths=[57 * mm, 57 * mm, 57 * mm])
    ai_table.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 3)]))
    story.extend([ai_table, Spacer(1, 8 * mm), p("可审计输出结构", styles["kicker"])])
    structured = [
        [p("输出字段", styles["table_head"]), p("用途", styles["table_head"]), p("失败时怎么做", styles["table_head"])],
        [p("paragraphs[].text", styles["table_bold"]), p("家书正文按段落展示和编辑", styles["table"]), p("空字段或非法结构直接拒绝，不显示半成品", styles["table"])],
        [p("sourceRefs / evidenceMap", styles["table_bold"]), p("每段正文能回到照片、语音或文字依据", styles["table"]), p("引用不一致则进入 needs-review，不能确认发布", styles["table"])],
        [p("safety / safetyTests", styles["table_bold"]), p("身份、事实、不确定词和第三方隐私的固定门槛", styles["table"]), p("安全结论不通过时停止确认，并保留可解释原因", styles["table"])],
    ]
    structured_table = Table(structured, colWidths=[49 * mm, 61 * mm, 61 * mm], repeatRows=1)
    structured_table.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, 0), INK), ("GRID", (0, 0), (-1, -1), 0.45, LINE), ("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 7), ("RIGHTPADDING", (0, 0), (-1, -1), 7), ("TOPPADDING", (0, 0), (-1, -1), 7), ("BOTTOMPADDING", (0, 0), (-1, -1), 7)]))
    story.extend([structured_table, Spacer(1, 8 * mm), p("CASE-001 安全事实", styles["kicker"]), p("语音只确认“开会有点累、外卖附送饮品、因此感觉开心”；照片只确认可见货架、商品和 9.9 元价签。具体饮品名称、购买/食用/功效、右侧路人身份均不推断。", styles["quote"]), p(f"自动验收：{esc(test_ids)} 共 7 条 PASS。它证明固定案例的安全边界，不替代真实供应商调用、人工事实核对或真人用户测试。", styles["small"]), PageBreak()])

    # Page 5: architecture and productization.
    story.extend(section_header(styles, "04", "从比赛 Demo 走向可推广软件", "本项目把一次家书演示拆成可替换的端、服务、AI、存储和发布能力，便于后续接入真实供应商和正式基础设施。"))
    architecture = [
        [p("微信小程序创作端", styles["table_head_center"]), p("Fastify API / 状态机", styles["table_head_center"]), p("AI Provider / 结构化输出", styles["table_head_center"]), p("H5 阅读与回复", styles["table_head_center"])],
        [p("素材主动选择、上传、编辑、确认", styles["center"]), p("上传校验、任务幂等、来源约束、分享凭据", styles["center"]), p("视觉/OCR/语音/文字理解；超时和非法输出拒绝", styles["center"]), p("大字阅读、来源、原音、回复和失效态", styles["center"])],
    ]
    architecture_table = Table(architecture, colWidths=[42.5 * mm] * 4)
    architecture_table.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, 0), INK), ("BACKGROUND", (0, 1), (-1, 1), WHITE), ("GRID", (0, 0), (-1, -1), 0.45, LINE), ("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("LEFTPADDING", (0, 0), (-1, -1), 7), ("RIGHTPADDING", (0, 0), (-1, -1), 7), ("TOPPADDING", (0, 0), (-1, -1), 8), ("BOTTOMPADDING", (0, 0), (-1, -1), 8)]))
    story.extend([architecture_table, Spacer(1, 8 * mm), p("产品化必须补齐的四个能力", styles["kicker"])])
    productization = [
        [p("能力", styles["table_head"]), p("为什么重要", styles["table_head"]), p("当前推进", styles["table_head"])],
        [p("可信 AI", styles["table_bold"]), p("赛规要求 AI 是核心价值，产品也需要稳定理解真实素材", styles["table"]), p("适配器和失败门禁已在代码中；真实四素材 E2E 待取证", styles["table"])],
        [p("隐私与分享", styles["table_bold"]), p("家庭内容不能因分享链接或日志泄漏", styles["table"]), p("短期读信/媒体凭据、撤销、限流和脱敏已有本地证据", styles["table"])],
        [p("输出一致性", styles["table_bold"]), p("长图、短片、H5 必须来自同一确认版本", styles["table"]), p("CASE-001 推荐长图已生成；confirmedDraft 离线渲染器已验证，线上任务和短片待接入", styles["table"])],
        [p("持续使用", styles["table_bold"]), p("日常、节日、照护等高频场景决定孵化潜力", styles["table"]), p("真人测试工具已准备；3+3 用户测试待开始", styles["table"])],
    ]
    product_table = Table(productization, colWidths=[38 * mm, 68 * mm, 67 * mm], repeatRows=1)
    product_table.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, 0), INK), ("GRID", (0, 0), (-1, -1), 0.45, LINE), ("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 7), ("RIGHTPADDING", (0, 0), (-1, -1), 7), ("TOPPADDING", (0, 0), (-1, -1), 6), ("BOTTOMPADDING", (0, 0), (-1, -1), 6)]))
    story.extend([product_table, Spacer(1, 8 * mm), p("工程接入位置", styles["kicker"]), p("共享契约：packages/contracts；服务端生成与确认：apps/api；微信创作端：apps/miniprogram；H5 阅读端：apps/web；受控素材构建与移交：scripts/create-controlled-case-demo.ps1。", styles["body"]), PageBreak()])

    # Page 6: evidence and status.
    story.extend(section_header(styles, "05", "证据先于宣称", "下面的状态可以直接被队友和评审复核；未完成的外部门禁明确保留，不用合成素材或静态截图代替。"))
    status_rows = [
        ("队友真实照片/语音/A-B/C", "已接入", "受控包使用物理裁切照片、原始 m4a 和固定审核稿；路径全部相对。"),
        ("本地代码闭环", "PASS", "contracts 17、Web 75、小程序 125、API 138，共 355/355。"),
        ("内容安全与隐私", "PASS", "T01-T07 全部通过；照片、语音和证据哈希已核对。"),
        ("真实 OpenAI 四素材", "待取证", "适配器存在，但尚无真实供应商 E2E 请求、响应和人工事实核对录像。"),
        ("微信双账号/双设备", "待完成", "上传、分享、播放、回复和失效链接真机证据尚未形成。"),
        ("真人用户测试", "待开始", "工具和工作簿已准备；3 名年轻用户和 3 名长辈评分尚未产生。"),
        ("动态长图/短片", "部分完成", "confirmedDraft 离线渲染器已通过直接/API 嵌套输入、长文和非法字段验证；线上任务、短片、打印预览和真机仍待完成。"),
    ]
    story.extend([status_table(styles, status_rows), Spacer(1, 8 * mm), p("受控成果包结构", styles["kicker"]), p("根目录 index.html 是唯一主入口；demo-case.js 和 demo-case.json 只引用相邻的 ./media/...；evidence/ 保存输出样例、安全规则、隐私审查、T01-T07 和 material manifest；exports/ 保存推荐 A 长图及核验清单。", styles["body"]), p("移交边界", styles["kicker"]), p("原始照片、开发输入、原始转写、系统提示词、DOCX/XLSX 和真人测试工具不进入主演示 ZIP，保留在团队受控源目录。清单中的“完整使用与融合教程.docx”目前未在源目录找到，不能用“实际成果册.docx”冒充。", styles["quote"]), PageBreak()])

    # Page 7: competition deliverables and roadmap.
    story.extend(section_header(styles, "06", "按赛规倒排交付", "参赛方向固定为“AI产品实现”。比赛材料、用户场景和软件产品化路线共用同一份证据链。"))
    competition_rows = [
        ("产品演示视频", "待完成", "30 秒至 3 分钟；前 3 秒给出痛点，随后展示真实 AI、来源、确认、阅读和回复。"),
        ("PDF 产品说明书", "本文件", "包含产品概述、目标用户、AI 角色和价值、技术实现、场景、边界与路线。"),
        ("快手双话题", "待提交", "同时使用 #AI未来挑战赛 和 #AI产品实现；发布后冻结。"),
        ("AIGC 创作声明", "待提交", "逐项记录 AI 工具来源；在平台勾选含 AI 生成内容。"),
        ("双人发布复核", "待完成", "发布者与复核者分离，检查视频、PDF、授权、链接、账号和冻结口径。"),
    ]
    story.extend([status_table(styles, competition_rows), Spacer(1, 8 * mm), p("下一波次建议", styles["kicker"])])
    roadmap = [
        [p("优先级", styles["table_head"]), p("动作", styles["table_head"]), p("退出证据", styles["table_head"])],
        [p("P0-1", styles["table_bold"]), p("用已授权脱敏四素材接入真实 OpenAI，保留请求/响应/失败/重试和人工核对记录", styles["table"]), p("真实供应商 E2E + sourceRefs + 事实核验录像", styles["table"])],
        [p("P0-2", styles["table_bold"]), p("完成微信两账号/两设备上传、分享、播放、回复和失效链接负向流程", styles["table"]), p("真机录像、请求时间线、错误 token 结果", styles["table"])],
        [p("P1-1", styles["table_bold"]), p("完成 3 名年轻用户 + 3 名长辈测试，按问题记录返修并复测", styles["table"]), p("评分、观察记录、问题关闭和 3 分钟完成率", styles["table"])],
        [p("P1-2", styles["table_bold"]), p("将已验证的 confirmedDraft 长图适配器接入 API 任务，再扩展短片", styles["table"]), p("线上正文/署名一致、打印预览、幂等重试和版权台账", styles["table"])],
    ]
    roadmap_table = Table(roadmap, colWidths=[22 * mm, 88 * mm, 63 * mm], repeatRows=1)
    roadmap_table.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, 0), INK), ("GRID", (0, 0), (-1, -1), 0.45, LINE), ("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 7), ("RIGHTPADDING", (0, 0), (-1, -1), 7), ("TOPPADDING", (0, 0), (-1, -1), 7), ("BOTTOMPADDING", (0, 0), (-1, -1), 7)]))
    story.extend([roadmap_table, Spacer(1, 9 * mm), p("提交前冻结规则", styles["kicker"]), p("提交后冻结快手作品、报名材料、PDF、体验入口和对应版本；后续研发进入独立分支，不替换已提交内容。公开视频至少预留 48 小时做账号、审核和链接检查。", styles["quote"]), PageBreak()])

    # Page 8: handoff appendix.
    story.extend(section_header(styles, "07", "接手人拿到什么", "这个阶段的交付不是一堆文件，而是一条能重跑、能复核、能继续推进的路径。"))
    handoff = [
        [p("入口", styles["table_head"]), p("位置 / 命令", styles["table_head"]), p("用途", styles["table_head"])],
        [p("队友展示", styles["table_bold"]), p("受控 ZIP 根目录 index.html", styles["table"]), p("换电脑后双击即可查看真实照片、原始 m4a、A/B/C 和完整交互", styles["table"])],
        [p("React H5", styles["table_bold"]), p("pnpm dev:web:case-001", styles["table"]), p("4173 受控阅读端；启动时校验媒体和 demo-case.json 哈希", styles["table"])],
        [p("阶段汇报", styles["table_bold"]), p("暖笺_阶段成果展示.html", styles["table"]), p("不从仓库开始讲；先看 CASE-001 实材，再看闭环和边界", styles["table"])],
        [p("当前交接", styles["table_bold"]), p("docs/CURRENT_HANDOFF_STATUS_2026-08-28.md", styles["table"]), p("唯一当前状态、证据、风险、下一步和 C 盘/D 盘说明", styles["table"])],
    ]
    handoff_table = Table(handoff, colWidths=[32 * mm, 70 * mm, 71 * mm], repeatRows=1)
    handoff_table.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, 0), INK), ("GRID", (0, 0), (-1, -1), 0.45, LINE), ("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 7), ("RIGHTPADDING", (0, 0), (-1, -1), 7), ("TOPPADDING", (0, 0), (-1, -1), 7), ("BOTTOMPADDING", (0, 0), (-1, -1), 7)]))
    story.extend([handoff_table, Spacer(1, 8 * mm), p("交接时先做三件事", styles["kicker"]), p("1. 核对受控包 SHA-256 和三项来源哈希。<br/>2. 在 390×844 和桌面尺寸完整走一遍素材选择、A/B/C、编辑来源、确认、阅读和回复。<br/>3. 选择一个 P0 工作项，先定义退出证据，再开始编码；项目经理每天记录完成事实、风险变化和下一证据。", styles["body"]), HRFlowable(width="100%", thickness=0.8, color=VERMILION, spaceBefore=6 * mm, spaceAfter=6 * mm), p("一句话带走", styles["kicker"]), p("暖笺已经证明：队友的真实生活素材可以在隐私边界内进入一条可操作的家书产品闭环。下一步要补齐真实 AI、双设备和真人反馈证据，让它能被真实用户持续使用。", styles["quote"]), Spacer(1, 3 * mm), p("本文件为阶段版内部受控材料。最终参赛 PDF、视频、平台声明和报名字段仍需双人复核后冻结。", styles["small"])] )

    document.build(story, onFirstPage=draw_page, onLaterPages=draw_page)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--package-root", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    build_pdf(args.package_root.resolve(), args.output.resolve())
    print(args.output.resolve())


if __name__ == "__main__":
    main()
