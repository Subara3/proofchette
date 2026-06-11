"""AmiVoice Cloud Platform 同期 HTTP インタフェースのラッパー。

声の校正指示を文字に起こすために使います。短い発話（数秒〜数十秒）を
そのつど送る使い方なので、リアルタイム WebSocket ではなく同期 HTTP で十分です。

参考: https://docs.amivoice.com/amivoice-api/manual/sync-http-interface/
"""

import os
import requests

# ログ保存なしのエンドポイント（入力した音声がサーバに残りません）。
# ログを残してよい場合は "/v1/recognize" に変えてください。
AMIVOICE_ENDPOINT = "https://acp-api.amivoice.com/v1/nolog/recognize"

# ユーザー辞書（単語登録）API のベース URL。
# 実際の URL は {BASE}/{エンジン名}/{プロファイルID} の形になります。
PROFILEWORDS_BASE = "https://acp-api.amivoice.com/profilewords"


def _app_key():
    return os.environ.get("AMIVOICE_APP_KEY", "").strip()


def _profile_id():
    # 認識・単語登録で使うプロファイル ID。
    # マイページ辞書を使う場合は ":サービスID" を設定します。
    return os.environ.get("AMIVOICE_PROFILE_ID", "").strip()


class AmiVoiceError(RuntimeError):
    pass


def transcribe(audio_bytes, filename="audio.webm", engine="-a-general", timeout=60):
    """音声バイト列を AmiVoice に投げて、認識テキストを返します。

    Args:
        audio_bytes: 録音した音声データ（webm/wav など）。
        filename:    マルチパート送信時のファイル名（拡張子で形式が伝わります）。
        engine:      認識エンジン。会話汎用は "-a-general"。
        timeout:     タイムアウト秒数。

    Returns:
        認識した日本語テキスト（str）。
    """
    app_key = _app_key()
    if not app_key:
        raise AmiVoiceError(
            "環境変数 AMIVOICE_APP_KEY が未設定です。"
            "AmiVoice のマイページで取得した APPKEY を設定してください。"
        )

    # d パラメータに認識エンジンを指定。登録先プロファイルがあれば一緒に渡し、
    # 登録した単語が認識に反映されるようにします。
    profile = _profile_id()
    if profile:
        d = f"grammarFileNames={engine} profileId={profile}"
    else:
        d = engine
    data = {"u": app_key, "d": d}
    files = {"a": (filename, audio_bytes, "application/octet-stream")}

    try:
        resp = requests.post(AMIVOICE_ENDPOINT, data=data, files=files, timeout=timeout)
    except requests.RequestException as e:
        raise AmiVoiceError(f"AmiVoice への通信に失敗しました: {e}") from e

    if resp.status_code != 200:
        raise AmiVoiceError(
            f"AmiVoice がエラーを返しました (HTTP {resp.status_code}): {resp.text[:300]}"
        )

    try:
        body = resp.json()
    except ValueError as e:
        raise AmiVoiceError(f"AmiVoice の応答を JSON として解釈できませんでした: {e}") from e

    # 認識失敗時は code/message が入ります。
    if body.get("code") and body.get("code") not in ("", "0"):
        message = body.get("message", "(詳細不明)")
        raise AmiVoiceError(f"AmiVoice 認識エラー [{body.get('code')}]: {message}")

    # トップレベルの text に全文が入ります。
    text = body.get("text")
    if not text:
        # results 配列側から拾うフォールバック。
        results = body.get("results") or []
        text = "".join(r.get("text", "") for r in results)

    return (text or "").strip()


def _require_profile():
    """単語登録に必要な APPKEY とプロファイル ID を確認して返す。"""
    app_key = _app_key()
    profile = _profile_id()
    if not app_key:
        raise AmiVoiceError("環境変数 AMIVOICE_APP_KEY が未設定です。")
    if not profile:
        raise AmiVoiceError(
            "環境変数 AMIVOICE_PROFILE_ID が未設定です。"
            "単語の登録先プロファイル ID を設定してください"
            "（マイページ辞書を使う場合は ':サービスID'）。"
        )
    return app_key, profile


def list_profile_words(engine="-a-general", timeout=30):
    """現在プロファイルに登録されている単語一覧 [{written, spoken}] を返す。"""
    app_key, profile = _require_profile()
    url = f"{PROFILEWORDS_BASE}/{engine}/{profile}"
    try:
        resp = requests.get(
            url, headers={"Authorization": f"Bearer {app_key}"}, timeout=timeout
        )
    except requests.RequestException as e:
        raise AmiVoiceError(f"単語一覧の取得に失敗しました: {e}") from e

    # プロファイル未作成の場合は空とみなす。
    if resp.status_code == 404:
        return []
    if resp.status_code != 200:
        raise AmiVoiceError(
            f"単語一覧の取得でエラー (HTTP {resp.status_code}): {resp.text[:300]}"
        )
    try:
        body = resp.json()
    except ValueError:
        return []
    return body.get("profilewords") or []


def save_profile_words(new_words, engine="-a-general", timeout=30):
    """選んだ語をプロファイルに登録する。

    このAPIは「送った単語で総入れ替え」になるため、既存の単語を取得してから
    マージし、全件をまとめて送ります。既存を壊しません。

    Args:
        new_words: [{"term": 表記, "reading": 読み}, ...]

    Returns:
        {"added": 新規追加した件数, "total": 登録後の合計件数}
    """
    app_key, profile = _require_profile()

    existing = list_profile_words(engine, timeout)
    by_written = {}
    for w in existing:
        written = w.get("written")
        if written:
            by_written[written] = {"written": written, "spoken": w.get("spoken", "")}

    added = 0
    for nw in new_words:
        written = (nw.get("term") or "").strip()
        spoken = (nw.get("reading") or "").strip()
        if not written or not spoken:  # 読み必須
            continue
        if written not in by_written:
            added += 1
        by_written[written] = {"written": written, "spoken": spoken}

    merged = list(by_written.values())

    url = f"{PROFILEWORDS_BASE}/{engine}/{profile}"
    try:
        resp = requests.post(
            url,
            headers={
                "Authorization": f"Bearer {app_key}",
                "Content-Type": "application/json",
            },
            json={"profilewords": merged},
            timeout=timeout,
        )
    except requests.RequestException as e:
        raise AmiVoiceError(f"単語の登録に失敗しました: {e}") from e

    if resp.status_code != 200:
        raise AmiVoiceError(
            f"単語の登録でエラー (HTTP {resp.status_code}): {resp.text[:300]}"
        )

    return {"added": added, "total": len(merged)}
