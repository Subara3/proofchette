"""proofchette（校正用プランシェット）— 声で赤入れする校正ツールの Flask バックエンド。

起動:
    pip install -r requirements.txt
    cp .env.example .env  # キーを記入
    python app.py
    → http://127.0.0.1:5050 （PORT で変更可）
"""

import os

from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, request

import amivoice
import claude_proofreader
import storage

load_dotenv()

app = Flask(__name__)


@app.route("/")
def index():
    # AmiVoice キーの有無を画面側に伝え、未設定でも手入力で試せるようにする。
    return render_template(
        "index.html",
        amivoice_enabled=bool(os.environ.get("AMIVOICE_APP_KEY", "").strip()),
        profile_enabled=bool(os.environ.get("AMIVOICE_PROFILE_ID", "").strip()),
    )


@app.route("/api/transcribe", methods=["POST"])
def transcribe():
    """録音した音声を AmiVoice に渡し、指示テキストを返す。"""
    if "audio" not in request.files:
        return jsonify({"error": "音声データがありません。"}), 400

    f = request.files["audio"]
    audio_bytes = f.read()
    if not audio_bytes:
        return jsonify({"error": "音声データが空です。"}), 400

    try:
        text = amivoice.transcribe(audio_bytes, filename=f.filename or "audio.webm")
    except amivoice.AmiVoiceError as e:
        return jsonify({"error": str(e)}), 502

    return jsonify({"text": text})


@app.route("/api/proofread", methods=["POST"])
def proofread():
    """原稿 + 指示を Claude に渡し、校正案を返す。"""
    data = request.get_json(silent=True) or {}
    manuscript = (data.get("manuscript") or "").strip()
    instruction = (data.get("instruction") or "").strip()

    if not manuscript:
        return jsonify({"error": "原稿が空です。"}), 400
    if not instruction:
        return jsonify({"error": "指示が空です。"}), 400

    style = (data.get("style") or "auto").strip()
    history = data.get("history") or []

    try:
        result = claude_proofreader.proofread(
            manuscript, instruction, style=style, history=history)
    except Exception as e:  # noqa: BLE001  叩き台なのでまとめて拾う
        return jsonify({"error": f"校正案の生成に失敗しました: {e}"}), 502

    return jsonify(result)


@app.route("/api/extract-terms", methods=["POST"])
def terms_extract():
    """原稿から音声認識の単語登録候補を抽出する。"""
    data = request.get_json(silent=True) or {}
    manuscript = (data.get("manuscript") or "").strip()
    if not manuscript:
        return jsonify({"error": "原稿が空です。"}), 400
    try:
        result = claude_proofreader.extract_terms(manuscript)
    except Exception as e:  # noqa: BLE001
        return jsonify({"error": f"単語候補の抽出に失敗しました: {e}"}), 502
    return jsonify(result)


@app.route("/api/register-words", methods=["POST"])
def register_words():
    """選んだ単語を AmiVoice のプロファイルに登録する。"""
    data = request.get_json(silent=True) or {}
    words = data.get("words") or []
    if not words:
        return jsonify({"error": "登録する単語がありません。"}), 400
    try:
        result = amivoice.save_profile_words(words)
    except amivoice.AmiVoiceError as e:
        return jsonify({"error": str(e)}), 502
    return jsonify(result)


# ---- 原稿の保存・管理 ----

@app.route("/api/docs", methods=["GET"])
def docs_list():
    return jsonify({"docs": storage.list_docs()})


@app.route("/api/docs", methods=["POST"])
def docs_create():
    data = request.get_json(silent=True) or {}
    meta = storage.create_doc(
        title=(data.get("title") or "無題の原稿"),
        body=(data.get("body") or ""),
    )
    return jsonify(meta)


@app.route("/api/docs/<doc_id>", methods=["GET"])
def docs_get(doc_id):
    try:
        doc = storage.get_doc(doc_id)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    if doc is None:
        return jsonify({"error": "原稿が見つかりません。"}), 404
    return jsonify(doc)


@app.route("/api/docs/<doc_id>", methods=["PUT"])
def docs_save(doc_id):
    data = request.get_json(silent=True) or {}
    try:
        meta = storage.save_doc(doc_id, title=data.get("title"), body=data.get("body"))
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    if meta is None:
        return jsonify({"error": "原稿が見つかりません。"}), 404
    return jsonify(meta)


@app.route("/api/docs/<doc_id>/history", methods=["GET"])
def history_list(doc_id):
    try:
        entries = storage.list_history(doc_id)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    # 本文スナップショットは一覧では重いので、件数と要約だけ返す。
    slim = [
        {
            "index": i,
            "ts": e.get("ts", 0),
            "summary": e.get("summary", ""),
            "edits": e.get("edits", []),
        }
        for i, e in enumerate(entries)
    ]
    return jsonify({"history": slim})


@app.route("/api/docs/<doc_id>/history", methods=["POST"])
def history_add(doc_id):
    data = request.get_json(silent=True) or {}
    try:
        storage.add_history(
            doc_id,
            body_before=data.get("body_before") or "",
            edits=data.get("edits") or [],
            summary=data.get("summary") or "",
        )
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify({"ok": True})


@app.route("/api/docs/<doc_id>/restore", methods=["POST"])
def history_restore(doc_id):
    """指定した履歴エントリの「適用直前」の本文に戻す。"""
    data = request.get_json(silent=True) or {}
    index = data.get("index")
    try:
        entries = storage.list_history(doc_id)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    if not isinstance(index, int) or not (0 <= index < len(entries)):
        return jsonify({"error": "履歴が見つかりません。"}), 404
    body = entries[index].get("body_before", "")
    meta = storage.save_doc(doc_id, body=body)
    if meta is None:
        return jsonify({"error": "原稿が見つかりません。"}), 404
    return jsonify({"ok": True, "body": body})


@app.route("/api/docs/<doc_id>", methods=["DELETE"])
def docs_delete(doc_id):
    try:
        ok = storage.delete_doc(doc_id)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    if not ok:
        return jsonify({"error": "原稿が見つかりません。"}), 404
    return jsonify({"ok": True})


if __name__ == "__main__":
    # Windows ではポート 5000 が予約レンジ（Hyper-V/WinNAT）に当たり
    # WinError 10013 で弾かれることがあるため、既定を 5050 にして PORT で上書き可能に。
    port = int(os.environ.get("PORT", "5050"))
    app.run(host="127.0.0.1", port=port, debug=True)
