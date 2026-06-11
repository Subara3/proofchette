"""デモGIF用の操作動画を Playwright で録画する。

指示の手入力 → 校正案の生成 → カードにホバーするとハイライトが原稿上を滑る
→ 採用すると緑にフラッシュ、までを一連で見せる。
ヘッドレス録画では OS カーソルが映らないので、朱色の擬似カーソルを注入する。
"""

import time
import requests
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:5050"

BODY = (
    "俺は静かに頷いた。けれども、心の中では納得していなかった。\n\n"
    "窓の外を流れる景色は、もう何時間も同じだった。サーバの仕事を辞めてから、"
    "初めての長い旅だった。\n\n"
    "「どこまで行くんですか」と隣の席の老人が聞いた。終点まで、と俺は答えた。"
)

INSTRUCTION = "2段落目の「けれども」を「しかし」に。「サーバの仕事」は「サーバーの仕事」に。"

FAKE_CURSOR = """
const dot = document.createElement('div');
dot.style.cssText = 'position:fixed;width:16px;height:16px;border-radius:50%;' +
  'background:rgba(184,67,47,.65);box-shadow:0 0 0 3px rgba(184,67,47,.25);' +
  'z-index:99999;pointer-events:none;left:-30px;top:-30px;' +
  'transition:left .06s linear, top .06s linear';
document.addEventListener('mousemove', e => {
  dot.style.left = (e.clientX - 8) + 'px';
  dot.style.top = (e.clientY - 8) + 'px';
});
document.body.appendChild(dot);
"""


def glide(page, x, y, steps=24):
    page.mouse.move(x, y, steps=steps)
    page.wait_for_timeout(150)


def main():
    # 原稿を初期状態に戻す（既存の最初のドキュメントを使う）
    docs = requests.get(f"{BASE}/api/docs").json()["docs"]
    if docs:
        doc_id = docs[0]["id"]
        requests.put(f"{BASE}/api/docs/{doc_id}",
                     json={"title": "夜行列車（短編）", "body": BODY})
    else:
        requests.post(f"{BASE}/api/docs",
                      json={"title": "夜行列車（短編）", "body": BODY})

    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(
            viewport={"width": 1380, "height": 940},
            record_video_dir="video",
            record_video_size={"width": 1380, "height": 940},
        )
        page = ctx.new_page()
        page.goto(BASE)
        page.wait_for_timeout(2200)
        page.evaluate(FAKE_CURSOR)
        page.wait_for_timeout(600)

        # 指示をタイプ（声の代わり。録画では入力欄に文字が流れる）
        ins = page.locator("#instruction")
        box = ins.bounding_box()
        glide(page, box["x"] + 200, box["y"] + 40)
        ins.click()
        page.keyboard.type(INSTRUCTION, delay=34)
        page.wait_for_timeout(500)

        # 生成
        gen = page.locator("#proofreadBtn")
        box = gen.bounding_box()
        glide(page, box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
        gen.click()
        page.wait_for_selector(".edit-card", timeout=120000)
        page.wait_for_timeout(1300)

        # カード1にホバー → プランシェットが滑る
        card = page.locator(".edit-card").nth(0)
        box = card.bounding_box()
        glide(page, box["x"] + box["width"] / 2, box["y"] + 30, steps=30)
        page.wait_for_timeout(1700)

        # カード2にホバー → ハイライトが移動
        cards = page.locator(".edit-card")
        if cards.count() > 1:
            box = cards.nth(1).bounding_box()
            glide(page, box["x"] + box["width"] / 2, box["y"] + 30, steps=20)
            page.wait_for_timeout(1700)

        # カード1を適用 → 緑フラッシュ
        btn = page.locator(".edit-card .apply-one").first
        box = btn.bounding_box()
        glide(page, box["x"] + box["width"] / 2, box["y"] + box["height"] / 2, steps=18)
        btn.click()
        page.wait_for_timeout(1800)

        # 残りをまとめて適用
        all_btn = page.locator("#applyAllBtn")
        box = all_btn.bounding_box()
        glide(page, box["x"] + box["width"] / 2, box["y"] + box["height"] / 2, steps=18)
        all_btn.click()
        page.wait_for_timeout(2200)

        ctx.close()  # 動画を確定
        browser.close()
    print("video saved under experiments/video/")


if __name__ == "__main__":
    main()
