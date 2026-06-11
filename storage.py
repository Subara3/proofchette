"""原稿をサーバ側にファイルとして保存・管理するモジュール。

manuscripts/ ディレクトリに本文を .md で置き、index.json でメタ情報
（タイトル・更新日時）をまとめて管理します。SQLite を使わずファイルにしているのは、
原稿を直接開ける・Git で管理できる・バックアップしやすい、という扱いやすさのためです。

原稿 ID は uuid の hex（16進文字のみ）。これをそのままファイル名に使うため、
パストラバーサルの心配がありません。
"""

import json
import os
import re
import time
import uuid

BASE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "manuscripts")
INDEX_PATH = os.path.join(BASE_DIR, "index.json")

# 許可する ID 形式（hex のみ）。これ以外はファイルアクセスさせない。
_ID_RE = re.compile(r"^[0-9a-f]{32}$")


def _ensure_base():
    os.makedirs(BASE_DIR, exist_ok=True)
    if not os.path.exists(INDEX_PATH):
        _write_index([])


def _read_index():
    _ensure_base()
    try:
        with open(INDEX_PATH, encoding="utf-8") as f:
            return json.load(f)
    except (ValueError, OSError):
        return []


def _write_index(items):
    with open(INDEX_PATH, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False, indent=2)


def _doc_path(doc_id):
    if not _ID_RE.match(doc_id):
        raise ValueError("不正な原稿 ID です。")
    return os.path.join(BASE_DIR, f"{doc_id}.md")


def list_docs():
    """原稿の一覧（更新日時の新しい順）を返す。"""
    items = _read_index()
    items.sort(key=lambda x: x.get("updated_at", 0), reverse=True)
    return items


def create_doc(title="無題の原稿", body=""):
    """新しい原稿を作り、メタ情報を返す。"""
    _ensure_base()
    doc_id = uuid.uuid4().hex
    now = time.time()
    with open(_doc_path(doc_id), "w", encoding="utf-8") as f:
        f.write(body)
    items = _read_index()
    meta = {"id": doc_id, "title": title or "無題の原稿", "updated_at": now}
    items.append(meta)
    _write_index(items)
    return meta


def get_doc(doc_id):
    """本文とメタ情報を返す。存在しなければ None。"""
    path = _doc_path(doc_id)
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as f:
        body = f.read()
    meta = next((i for i in _read_index() if i["id"] == doc_id), None)
    if meta is None:
        return None
    return {"id": doc_id, "title": meta["title"], "body": body,
            "updated_at": meta.get("updated_at", 0)}


def save_doc(doc_id, title=None, body=None):
    """本文・タイトルを更新する。存在しなければ None。"""
    items = _read_index()
    meta = next((i for i in items if i["id"] == doc_id), None)
    if meta is None:
        return None

    if body is not None:
        with open(_doc_path(doc_id), "w", encoding="utf-8") as f:
            f.write(body)
    if title is not None and title.strip():
        meta["title"] = title.strip()
    meta["updated_at"] = time.time()
    _write_index(items)
    return meta


def delete_doc(doc_id):
    """原稿を削除する。"""
    items = _read_index()
    meta = next((i for i in items if i["id"] == doc_id), None)
    if meta is None:
        return False
    path = _doc_path(doc_id)
    if os.path.exists(path):
        os.remove(path)
    hpath = _history_path(doc_id)
    if os.path.exists(hpath):
        os.remove(hpath)
    _write_index([i for i in items if i["id"] != doc_id])
    return True


# ---- 採用履歴（スナップショット付き） ----
# 修正を適用するたびに「適用直前の本文」と「適用した編集」を1行のJSONで残す。
# 戻す・編集ログの書き出しの両方をこれ一本で賄う。

HISTORY_LIMIT = 50  # 1原稿あたり残す履歴の上限


def _history_path(doc_id):
    if not _ID_RE.match(doc_id):
        raise ValueError("不正な原稿 ID です。")
    return os.path.join(BASE_DIR, f"{doc_id}.history.jsonl")


def add_history(doc_id, body_before, edits, summary=""):
    """適用イベントを履歴に追記する。"""
    _ensure_base()
    entry = {
        "ts": time.time(),
        "body_before": body_before,
        "edits": edits,
        "summary": summary,
    }
    entries = list_history(doc_id)
    entries.append(entry)
    entries = entries[-HISTORY_LIMIT:]
    with open(_history_path(doc_id), "w", encoding="utf-8") as f:
        for e in entries:
            f.write(json.dumps(e, ensure_ascii=False) + "\n")
    return entry


def list_history(doc_id):
    """履歴を古い順のリストで返す。"""
    path = _history_path(doc_id)
    if not os.path.exists(path):
        return []
    entries = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entries.append(json.loads(line))
            except ValueError:
                continue
    return entries
