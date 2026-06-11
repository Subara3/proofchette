"""単語登録（profilewords）の効果測定。

20語×各1文のTTS音声を AmiVoice に投げ、
  1. 登録なし（素の -a-general）
  2. 20語を実験用プロファイルに登録した状態
の2条件で認識し、目的の表記が出るかを比べる。

実験用プロファイル proofchette-exp を使うので、普段の辞書は汚さない。
結果は results.json と results.md に保存する。
"""

import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env"))
os.environ["AMIVOICE_PROFILE_ID"] = "proofchette-exp"  # 実験専用プロファイル

import amivoice  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
AUDIO_DIR = os.path.join(HERE, "audio")


def load_terms():
    with open(os.path.join(HERE, "terms.json"), encoding="utf-8") as f:
        return json.load(f)["terms"]


def recognize_all(terms, with_profile):
    """全音声を認識して [{written, text, hit}] を返す。"""
    results = []
    for i, t in enumerate(terms):
        path = os.path.join(AUDIO_DIR, f"{i:02d}.wav")
        with open(path, "rb") as f:
            audio = f.read()
        # with_profile=False のときは素のエンジン指定で投げる
        if with_profile:
            text = amivoice.transcribe(audio, filename=f"{i:02d}.wav")
        else:
            saved = os.environ.pop("AMIVOICE_PROFILE_ID", "")
            try:
                text = amivoice.transcribe(audio, filename=f"{i:02d}.wav")
            finally:
                os.environ["AMIVOICE_PROFILE_ID"] = saved
        hit = t["written"] in text
        results.append({"written": t["written"], "text": text, "hit": hit})
        print(f"  [{i:02d}] {'O' if hit else 'X'} {t['written']!r} -> {text}")
        time.sleep(0.3)  # 行儀よく
    return results


def main():
    terms = load_terms()
    n = len(terms)

    print(f"=== 1/3 登録なしで {n} 文を認識 ===")
    before = recognize_all(terms, with_profile=False)

    print("=== 2/3 単語登録 ===")
    words = [{"term": t["written"], "reading": t["reading"]} for t in terms]
    reg = amivoice.save_profile_words(words)
    print(f"  登録: {reg}")
    time.sleep(2)

    print(f"=== 3/3 登録ありで {n} 文を認識 ===")
    after = recognize_all(terms, with_profile=True)

    hit_b = sum(r["hit"] for r in before)
    hit_a = sum(r["hit"] for r in after)

    out = {
        "n": n,
        "hit_before": hit_b,
        "hit_after": hit_a,
        "rows": [
            {
                "category": t["category"],
                "written": t["written"],
                "reading": t["reading"],
                "sentence": t["sentence_display"],
                "before": b["text"],
                "before_hit": b["hit"],
                "after": a["text"],
                "after_hit": a["hit"],
            }
            for t, b, a in zip(terms, before, after)
        ],
    }
    with open(os.path.join(HERE, "results.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)

    # 記事に貼れる Markdown 表も出す
    lines = [
        f"単語登録なし: {hit_b}/{n} 語が正しい表記 / 単語登録あり: {hit_a}/{n} 語が正しい表記",
        "",
        "| 語 | 読み | 登録なし | 登録あり |",
        "| --- | --- | --- | --- |",
    ]
    for r in out["rows"]:
        mb = "✅" if r["before_hit"] else "❌"
        ma = "✅" if r["after_hit"] else "❌"
        lines.append(f"| {r['written']} | {r['reading']} | {mb} `{r['before']}` | {ma} `{r['after']}` |")
    with open(os.path.join(HERE, "results.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")

    print(f"\n登録なし {hit_b}/{n} -> 登録あり {hit_a}/{n}")
    print("results.json / results.md に保存しました。")


if __name__ == "__main__":
    main()
