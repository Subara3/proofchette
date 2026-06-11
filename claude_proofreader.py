"""proofchette（校正用プランシェット）の頭脳。

声で出した校正指示を LLM に解釈させ、原稿への赤入れ案を生成するモジュール。

AmiVoice が起こした「指示テキスト」と「原稿」を渡すと、
どこをどう直すかの編集リスト（before / after / 理由）を返します。

頭脳は Anthropic / OpenAI のどちらでも動きます。
- ANTHROPIC_API_KEY があれば Anthropic（既定モデル claude-sonnet-4-6）を優先。
- 無ければ OPENAI_API_KEY を使う（既定モデル gpt-4o）。
- どちらも無ければエラー。
モデルは PROOFREAD_MODEL / OPENAI_MODEL で上書きできます。
"""

import json
import os

# Anthropic 用の既定モデル。精度を上げたいときは "claude-opus-4-8" 等に。
ANTHROPIC_MODEL = os.environ.get("PROOFREAD_MODEL", "claude-sonnet-4-6")
# OpenAI 用の既定モデル。
OPENAI_MODEL = os.environ.get("OPENAI_MODEL", "gpt-4o")


def _provider():
    """使う頭脳を決める。Anthropic を優先し、無ければ OpenAI。"""
    if os.environ.get("ANTHROPIC_API_KEY", "").strip():
        return "anthropic"
    if os.environ.get("OPENAI_API_KEY", "").strip():
        return "openai"
    raise RuntimeError(
        "ANTHROPIC_API_KEY も OPENAI_API_KEY も未設定です。"
        "校正案を生成するには、どちらかの API キーを .env に設定してください。"
    )


def _complete(system_prompt, user_content, max_tokens=4000):
    """system + user を渡し、モデルの応答テキスト(str)を返す。

    出力は JSON 文字列を想定（プロンプト側で JSON のみを指示している）。
    """
    provider = _provider()

    if provider == "anthropic":
        import anthropic

        client = anthropic.Anthropic()  # ANTHROPIC_API_KEY を環境変数から読む。
        message = client.messages.create(
            model=ANTHROPIC_MODEL,
            max_tokens=max_tokens,
            system=system_prompt,
            messages=[{"role": "user", "content": user_content}],
        )
        return "".join(b.text for b in message.content if b.type == "text")

    # provider == "openai"
    from openai import OpenAI

    client = OpenAI()  # OPENAI_API_KEY を環境変数から読む。
    resp = client.chat.completions.create(
        model=OPENAI_MODEL,
        max_tokens=max_tokens,
        # プロンプトで JSON のみを要求しているので、JSON モードで取りこぼしを防ぐ。
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ],
    )
    return resp.choices[0].message.content or ""


def _parse_json(raw):
    """モデルの応答テキストから JSON 部分を取り出して dict にする。"""
    raw = (raw or "").strip()
    # 念のためコードフェンスが付いていたら剥がす。
    if raw.startswith("```"):
        raw = raw.strip("`")
        if raw.lstrip().lower().startswith("json"):
            raw = raw.lstrip()[4:]
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        # JSON 部分だけ救出を試みる。
        start = raw.find("{")
        end = raw.rfind("}")
        if start != -1 and end != -1:
            return json.loads(raw[start : end + 1])
        raise


SYSTEM_PROMPT = """あなたは日本語の原稿校正を担当する編集者です。
ユーザーは原稿を読み返しながら、口頭で校正の指示を出します（その音声を書き起こしたものが「指示」です）。
指示と原稿を読み、原稿に対する具体的な修正案を作ってください。

ルール:
- 指示で名指しされた箇所を最優先で直す。「2段落目の」「最後の文の」などの位置指定を丁寧に解釈する。
- 指示が「全体の誤字脱字を見て」「てにをはを整えて」のように包括的な場合は、該当する箇所をすべて拾う。
- 各修正は、原稿中に実在する文字列(before)と、それを置き換える文字列(after)のペアで表す。
- before は原稿から一意に特定できる程度の長さにする（短すぎて複数箇所に当たらないように、必要なら前後を含める）。
- 元の意図・文体を尊重し、過剰な書き換えはしない。創作文の場合は特に作者の表現を残す。
- 削除したい場合は after を空文字にする。
- 確信が持てない・指示が曖昧な場合も、最も妥当な解釈で案を出し、reason にその旨を書く。

出力は必ず次の JSON のみ。前置き・コードフェンス・解説は一切付けない。
{
  "summary": "今回の校正方針を1〜2文で",
  "edits": [
    {"before": "原稿中の該当文字列", "after": "修正後の文字列",
     "reason": "なぜそう直すか（簡潔に）",
     "type": "誤字脱字 / 表記ゆれ / 文体 / 冗長 / その他 のいずれか"}
  ]
}
修正すべき箇所が無ければ edits は空配列にし、summary でその旨を伝える。"""

EDIT_TYPES = ("誤字脱字", "表記ゆれ", "文体", "冗長", "その他")


# 文体プリセット。画面のチップで選び、校正の方針を切り替える。
STYLE_GUIDES = {
    "novel": (
        "この原稿は小説（創作文）です。\n"
        "- 作者の文体・リズム・意図的な言い回しの崩しを最大限尊重し、赤入れは控えめにする。\n"
        "- 明らかな誤字脱字・誤用・表記ゆれを優先し、表現の好みには踏み込まない。\n"
        "- 同一人物のセリフの口調（一人称・語尾）がぶれていれば指摘する。"
    ),
    "tech": (
        "この原稿は技術記事です。\n"
        "- 技術用語の表記ゆれ（例: サーバ/サーバー）を統一する。\n"
        "- です・ます調の統一、冗長表現の簡潔化、受け身より能動的な書き方を優先する。\n"
        "- 手順や事実の記述は曖昧さを残さない表現に直す。"
    ),
    "biz": (
        "この原稿はビジネス文書です。\n"
        "- 敬語の誤り（二重敬語・謙譲と尊敬の混同）を正す。\n"
        "- 結論が先に来る構成を意識し、曖昧でぼかした表現は明確にする。\n"
        "- 相手に失礼のない、簡潔で礼を失わない言い回しにする。"
    ),
}


def proofread(manuscript, instruction, style="auto"):
    """原稿と校正指示を受け取り、校正案(dict)を返す。

    Args:
        style: 文体プリセット（auto / novel / tech / biz）。

    Returns:
        {"summary": str, "edits": [{"before","after","reason"}, ...]}
    """
    system_prompt = SYSTEM_PROMPT
    guide = STYLE_GUIDES.get(style)
    if guide:
        system_prompt = f"{SYSTEM_PROMPT}\n\n# 文体方針\n{guide}"

    user_content = (
        "# 原稿\n"
        "----\n"
        f"{manuscript}\n"
        "----\n\n"
        "# 指示（音声を書き起こしたもの）\n"
        f"{instruction}\n"
    )

    raw = _complete(system_prompt, user_content)
    result = _parse_json(raw)

    result.setdefault("summary", "")
    result.setdefault("edits", [])
    # 形式を整える。
    cleaned = []
    for e in result["edits"]:
        before = e.get("before", "")
        if before == "":
            continue
        etype = (e.get("type") or "").strip()
        if etype not in EDIT_TYPES:
            etype = "その他"
        cleaned.append(
            {
                "before": before,
                "after": e.get("after", ""),
                "reason": e.get("reason", ""),
                "type": etype,
            }
        )
    result["edits"] = cleaned
    return result


TERMS_SYSTEM_PROMPT = """あなたは日本語音声認識（AmiVoice のハイブリッド型・汎用エンジン）の単語登録を支援するアシスタントです。
渡された原稿を読み、声で口述したときに正しく変換されにくい単語を抽出してください。

抽出する対象:
- 固有名詞（人名・地名・会社名・作品名・サービス名・施設名など）
- 専門用語・技術用語・業界の略語
- 一般的な変換では出てこない造語・独自の表記
- 同音異義語が多く誤変換されやすい語

抽出しないもの:
- ふつうに変換できる一般語
- 読みが1〜2文字しかない極端に短い語（誤登録のもとになるため避ける）

各単語に次を付ける:
- term: 原稿中の表記そのまま
- reading: 読み（すべてひらがな。AmiVoice の「読み」に使う）
- category: 人名 / 地名 / 会社名 / 固有名詞 / 専門用語 / 作品名 / その他 のいずれか
- note: 登録すると良い理由（10〜30文字程度で簡潔に）

登録は最小限が望ましいので、本当に誤変換されやすいものに絞ってください。同じ表記の重複は避けます。

出力は必ず次の JSON のみ。前置き・コードフェンス・解説は付けない。
{
  "terms": [
    {"term": "...", "reading": "...", "category": "...", "note": "..."}
  ]
}
該当が無ければ terms は空配列にする。"""


def extract_terms(manuscript):
    """原稿から、音声認識の単語登録候補(dict)を抽出する。

    Returns:
        {"terms": [{"term","reading","category","note"}, ...]}
    """
    raw = _complete(TERMS_SYSTEM_PROMPT, f"# 原稿\n----\n{manuscript}\n----\n")
    result = _parse_json(raw)
    result.setdefault("terms", [])

    cleaned = []
    seen = set()
    for t in result["terms"]:
        term = (t.get("term") or "").strip()
        if not term or term in seen:
            continue
        seen.add(term)
        cleaned.append(
            {
                "term": term,
                "reading": (t.get("reading") or "").strip(),
                "category": (t.get("category") or "").strip(),
                "note": (t.get("note") or "").strip(),
            }
        )
    result["terms"] = cleaned
    return result
