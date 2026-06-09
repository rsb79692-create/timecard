"""
穂乃味タイムカード 有給申請マニュアル用 画面画像生成スクリプト
方針B: Pillow で実アプリのUI色を忠実に再現した疑似スクリーンショット＋アノテーション
"""

from PIL import Image, ImageDraw, ImageFont
import os

# ============================================================
# 定数・カラー（index.html から抽出）
# ============================================================
BG_APP    = "#eaecef"    # body 背景
BG_WHITE  = "#ffffff"
BG_CARD   = "#ffffff"    # .history / .admin-card
CLR_BLUE  = "#1e40af"    # プライマリ青
CLR_RED   = "#b91c1c"    # 退勤赤
CLR_GRAY  = "#475569"
CLR_LGRAY = "#adb5bd"
CLR_DGRAY = "#0f172a"
CLR_HINT  = "#8496a7"
CLR_GREEN_BG  = "#f0fdf4"
CLR_GREEN_BOR = "#86efac"
CLR_GREEN_TXT = "#166534"

OUT_DIR = os.path.dirname(os.path.abspath(__file__))

# ============================================================
# ヘルパー
# ============================================================
def hex2rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))

def draw_rounded_rect(draw, xy, radius, fill=None, outline=None, width=1):
    x0, y0, x1, y1 = xy
    if fill:
        draw.rounded_rectangle(xy, radius=radius, fill=fill, outline=outline, width=width)
    else:
        draw.rounded_rectangle(xy, radius=radius, outline=outline, width=width)

def annotation_circle(draw, cx, cy, num, r=16, font=None):
    """赤い番号付き丸ラベル"""
    draw.ellipse([cx-r, cy-r, cx+r, cy+r], fill="#e02020")
    txt = str(num)
    if font:
        bbox = font.getbbox(txt)
        tw = bbox[2] - bbox[0]
        th = bbox[3] - bbox[1]
        draw.text((cx - tw//2, cy - th//2 - 1), txt, fill="#ffffff", font=font)
    else:
        draw.text((cx-5, cy-8), txt, fill="#ffffff")

def annotation_rect(draw, xy, color="#e02020", lw=3):
    """赤い枠線"""
    x0,y0,x1,y1 = xy
    for i in range(lw):
        draw.rectangle([x0-i, y0-i, x1+i, y1+i], outline=color)

def load_font(size, bold=False):
    """利用可能な日本語フォントを探してロード"""
    candidates = [
        # Windows 標準 / Meiryo
        r"C:\Windows\Fonts\meiryo.ttc",
        r"C:\Windows\Fonts\meiryob.ttc",
        r"C:\Windows\Fonts\msgothic.ttc",
        r"C:\Windows\Fonts\YuGothM.ttc",
        r"C:\Windows\Fonts\YuGothB.ttc",
        r"C:\Windows\Fonts\NotoSansCJKjp-Regular.otf",
    ]
    for path in candidates:
        if os.path.exists(path):
            try:
                from PIL import ImageFont
                return ImageFont.truetype(path, size)
            except Exception:
                continue
    return ImageFont.load_default()

# フォントサイズ別キャッシュ
_FONTS = {}
def F(size):
    if size not in _FONTS:
        _FONTS[size] = load_font(size)
    return _FONTS[size]

def make_canvas(w=600, h=900, bg=BG_APP):
    img = Image.new("RGB", (w, h), hex2rgb(bg))
    draw = ImageDraw.Draw(img)
    return img, draw

# ============================================================
# 画面1: ホーム（スタッフ選択画面）
# ============================================================
def make_step1_home():
    W, H = 600, 800
    img, draw = make_canvas(W, H, BG_APP)

    # ── ヘッダー: 日付・時計 ──
    draw.text((W//2, 28), "2026年6月9日（火）", fill=hex2rgb(CLR_HINT), font=F(18), anchor="mt")
    draw.text((W//2, 56), "09:30:15", fill=hex2rgb(CLR_DGRAY), font=F(52), anchor="mt")

    # ラベル
    draw.text((W//2, 122), "スタッフを選択してください", fill=hex2rgb(CLR_HINT), font=F(16), anchor="mt")

    # あいうえおタブ
    tabs = ["すべて", "あ", "か", "さ", "た", "な", "は", "ま"]
    tx = 20
    ty = 152
    for i, t in enumerate(tabs):
        tw_px = 60 if t == "すべて" else 44
        bg_tab = CLR_BLUE if i == 0 else BG_WHITE
        fg_tab = "#ffffff" if i == 0 else CLR_GRAY
        draw.rounded_rectangle([tx, ty, tx+tw_px, ty+34], radius=5,
                                fill=hex2rgb(bg_tab), outline=hex2rgb(CLR_LGRAY), width=1)
        draw.text((tx + tw_px//2, ty + 17), t, fill=hex2rgb(fg_tab), font=F(15), anchor="mm")
        tx += tw_px + 5

    # スタッフボタン 2列グリッド
    staff = ["青木　太郎", "井上　花子", "上田　次郎", "大橋　三恵", "加藤　哲也", "木村　恵美"]
    col_w = (W - 40 - 8) // 2
    for idx, name in enumerate(staff):
        col = idx % 2
        row = idx // 2
        bx = 20 + col * (col_w + 8)
        by = 202 + row * (70 + 6)
        draw.rounded_rectangle([bx, by, bx+col_w, by+64], radius=2,
                                fill=hex2rgb(BG_WHITE), outline=hex2rgb(CLR_LGRAY), width=1)
        draw.text((bx + col_w//2, by + 32), name, fill=hex2rgb(CLR_DGRAY), font=F(22), anchor="mm")

    # 管理者メニューボタン
    draw.rounded_rectangle([20, 650, W-20, 684], radius=2,
                            fill=hex2rgb("#dde1e7"), outline=hex2rgb(CLR_LGRAY), width=1)
    draw.text((W//2, 667), "管理者メニュー", fill=hex2rgb(CLR_GRAY), font=F(16), anchor="mm")

    # ── アノテーション ──
    # ①「スタッフを選択してください」ラベル
    annotation_rect(draw, [14, 112, W-14, 140], lw=3)
    annotation_circle(draw, 22, 112, 1, font=F(14))

    # ②「青木　太郎」ボタンを強調
    annotation_rect(draw, [18, 200, 18+col_w+4, 270], lw=3)
    annotation_circle(draw, 18+col_w+4+16, 200, 2, font=F(14))

    # 凡例
    draw.rectangle([0, H-80, W, H], fill=hex2rgb("#f8fafc"))
    draw.line([0, H-80, W, H-80], fill=hex2rgb(CLR_LGRAY), width=1)
    draw.text((30, H-62), "① 「スタッフを選択してください」と表示されていることを確認", fill=hex2rgb(CLR_DGRAY), font=F(13))
    draw.text((30, H-38), "② 自分の名前のボタンをタップする", fill=hex2rgb(CLR_DGRAY), font=F(13))

    img.save(os.path.join(OUT_DIR, "step1_home.png"))
    print("step1_home.png saved")

# ============================================================
# 画面2: PIN 入力画面
# ============================================================
def make_step2_pin():
    W, H = 600, 820
    img, draw = make_canvas(W, H, BG_APP)

    # 戻るボタン
    draw.rounded_rectangle([20, 16, 110, 44], radius=2,
                            fill=hex2rgb("#dde1e7"), outline=hex2rgb(CLR_LGRAY), width=1)
    draw.text((65, 30), "← もどる", fill=hex2rgb(CLR_GRAY), font=F(14), anchor="mm")

    # スタッフ名
    draw.text((W//2, 72), "青木　太郎", fill=hex2rgb(CLR_DGRAY), font=F(44), anchor="mt")
    draw.text((W//2, 126), "PINを入力してください", fill=hex2rgb(CLR_HINT), font=F(18), anchor="mt")

    # PIN ドット表示
    dots = "●  ●  ●  ●"
    draw.text((W//2, 180), "────────", fill=hex2rgb("#c8ccd2"), font=F(36), anchor="mt")

    # テンキー
    nums = [1,2,3,4,5,6,7,8,9,"⌫",0,"→"]
    key_w, key_h = 164, 68
    gap = 8
    total_w = 3*key_w + 2*gap
    sx = (W - total_w) // 2
    sy = 250
    for i, n in enumerate(nums):
        col = i % 3
        row = i // 3
        kx = sx + col*(key_w+gap)
        ky = sy + row*(key_h+gap)
        if n == "→":
            bg_k = CLR_BLUE; fg_k = "#ffffff"
        elif n == "⌫":
            bg_k = "#dde1e7"; fg_k = CLR_HINT
        else:
            bg_k = BG_WHITE; fg_k = CLR_DGRAY
        draw.rounded_rectangle([kx, ky, kx+key_w, ky+key_h], radius=2,
                                fill=hex2rgb(bg_k), outline=hex2rgb(CLR_LGRAY), width=1)
        draw.text((kx+key_w//2, ky+key_h//2), str(n), fill=hex2rgb(fg_k), font=F(30), anchor="mm")

    # アノテーション
    annotation_rect(draw, [sx-4, sy-4, sx+total_w+4, sy+4*(key_h+gap)], lw=3)
    annotation_circle(draw, sx-4, sy-4, 1, font=F(14))
    # → ボタン強調
    kx2 = sx + 2*(key_w+gap)
    ky2 = sy + 3*(key_h+gap)
    annotation_rect(draw, [kx2-2, ky2-2, kx2+key_w+2, ky2+key_h+2], color="#0ea5e9", lw=3)
    annotation_circle(draw, kx2+key_w+2+16, ky2, 2, r=16, font=F(14))

    # 凡例
    draw.rectangle([0, H-80, W, H], fill=hex2rgb("#f8fafc"))
    draw.line([0, H-80, W, H-80], fill=hex2rgb(CLR_LGRAY), width=1)
    draw.text((30, H-62), "① 4桁のPINを数字ボタンで入力する", fill=hex2rgb(CLR_DGRAY), font=F(13))
    draw.text((30, H-38), "② 最後に「→」ボタンを押して確定する", fill=hex2rgb(CLR_DGRAY), font=F(13))

    img.save(os.path.join(OUT_DIR, "step2_pin.png"))
    print("step2_pin.png saved")

# ============================================================
# 画面3: 打刻画面（出勤後・有給申請ボタン表示）
# ============================================================
def make_step3_punch():
    W, H = 600, 900
    img, draw = make_canvas(W, H, BG_APP)

    # 戻るボタン
    draw.rounded_rectangle([20, 16, 110, 44], radius=2,
                            fill=hex2rgb("#dde1e7"), outline=hex2rgb(CLR_LGRAY), width=1)
    draw.text((65, 30), "← もどる", fill=hex2rgb(CLR_GRAY), font=F(14), anchor="mm")

    # スタッフ名・時計
    draw.text((W//2, 60), "青木　太郎", fill=hex2rgb(CLR_DGRAY), font=F(42), anchor="mt")
    draw.text((W//2, 114), "09:30:22", fill=hex2rgb(CLR_DGRAY), font=F(44), anchor="mt")
    draw.text((W//2, 166), "2026年6月9日（火）", fill=hex2rgb(CLR_HINT), font=F(16), anchor="mt")

    # 打刻ボタン 2x2
    btns = [
        ("🟢\n出　勤", CLR_BLUE, False),
        ("🔴\n退　勤", CLR_RED, True),
        ("☕\n休憩開始", "#374151", True),
        ("▶\n休憩終了", "#4b5563", True),
    ]
    btn_w = (W - 40 - 8) // 2
    for i, (label, bg, disabled) in enumerate(btns):
        col = i % 2; row = i // 2
        bx = 20 + col*(btn_w+8)
        by = 200 + row*(88+8)
        alpha = hex2rgb(bg) if not disabled else tuple(int(c*0.2+200*0.8) for c in hex2rgb(bg))
        draw.rounded_rectangle([bx, by, bx+btn_w, by+84], radius=2, fill=alpha)
        lines = label.split("\n")
        draw.text((bx+btn_w//2, by+20), lines[0], fill=(255,255,255), font=F(20), anchor="mt")
        draw.text((bx+btn_w//2, by+48), lines[1], fill=(255,255,255), font=F(24), anchor="mt")

    # 本日の打刻履歴
    hist_y = 408
    draw.rounded_rectangle([20, hist_y, W-20, hist_y+130], radius=2,
                            fill=hex2rgb(BG_WHITE), outline=hex2rgb(CLR_LGRAY), width=1)
    draw.text((36, hist_y+14), "本日の打刻履歴", fill=hex2rgb(CLR_HINT), font=F(16))
    draw.line([36, hist_y+42, W-36, hist_y+42], fill=hex2rgb("#e9ecef"), width=1)
    draw.text((36, hist_y+56), "出勤", fill=hex2rgb(CLR_BLUE), font=F(20))
    draw.text((W-36, hist_y+56), "09:15", fill=hex2rgb(CLR_DGRAY), font=F(20), anchor="rt")
    draw.line([36, hist_y+90, W-36, hist_y+90], fill=hex2rgb("#e9ecef"), width=1)
    draw.text((36, hist_y+100), "まだ退勤打刻がありません", fill=hex2rgb(CLR_HINT), font=F(14))

    # 書類アップロードエリア（折りたたみ）
    upload_y = 552
    draw.rounded_rectangle([20, upload_y, W-20, upload_y+54], radius=2,
                            fill=hex2rgb(BG_WHITE), outline=hex2rgb(CLR_LGRAY), width=1)
    draw.text((36, upload_y+16), "📎 書類をアップロード", fill=hex2rgb(CLR_DGRAY), font=F(15))

    # 有給申請ボタン（メイン対象）
    pl_y = 618
    draw.rounded_rectangle([20, pl_y, W-20, pl_y+60], radius=2,
                            fill=hex2rgb(CLR_GREEN_BG), outline=hex2rgb(CLR_GREEN_BOR), width=1)
    draw.text((W//2, pl_y+30), "有給申請", fill=hex2rgb(CLR_GREEN_TXT), font=F(22), anchor="mm")

    # ── アノテーション ──
    annotation_rect(draw, [18, pl_y-2, W-18, pl_y+62], lw=3)
    annotation_circle(draw, W-18+16, pl_y+30, 1, font=F(14))

    # 凡例
    draw.rectangle([0, H-80, W, H], fill=hex2rgb("#f8fafc"))
    draw.line([0, H-80, W, H-80], fill=hex2rgb(CLR_LGRAY), width=1)
    draw.text((30, H-62), "① 画面を下にスクロールすると「有給申請」ボタンが表示される", fill=hex2rgb(CLR_DGRAY), font=F(13))
    draw.text((30, H-38), "   緑色のボタンをタップして申請フォームを開く", fill=hex2rgb(CLR_DGRAY), font=F(13))

    img.save(os.path.join(OUT_DIR, "step3_punch.png"))
    print("step3_punch.png saved")

# ============================================================
# 画面4: 有給申請フォーム（カレンダー・日付選択）
# ============================================================
def make_step4_calendar():
    W, H = 600, 1000
    img, draw = make_canvas(W, H, BG_APP)

    # カード背景
    card_y = 20
    draw.rounded_rectangle([20, card_y, W-20, H-20], radius=2,
                            fill=hex2rgb(BG_WHITE), outline=hex2rgb(CLR_LGRAY), width=1)

    # タイトル
    draw.text((36, card_y+16), "有給申請", fill=hex2rgb(CLR_DGRAY), font=F(20))

    # 説明文
    draw.text((36, card_y+52), "取得日を選択してください（複数可）", fill=hex2rgb(CLR_GRAY), font=F(15))
    # 選択中バッジ
    draw.rounded_rectangle([360, card_y+46, 480, card_y+70], radius=10,
                            fill=hex2rgb("#dbeafe"))
    draw.text((420, card_y+58), "選択中: 2日", fill=hex2rgb(CLR_BLUE), font=F(14), anchor="mm")

    # 年月
    draw.text((36, card_y+82), "2026年6月", fill=hex2rgb("#b45309"), font=F(15))

    # カレンダーヘッダー
    days_label = ["日", "月", "火", "水", "木", "金", "土"]
    days_color = ["#dc2626", "#475569", "#475569", "#475569", "#475569", "#475569", "#1e40af"]
    cal_left = 36
    cell_w = (W - 72) // 7
    cal_y = card_y + 110

    for i, (dl, dc) in enumerate(zip(days_label, days_color)):
        cx = cal_left + i*cell_w + cell_w//2
        draw.text((cx, cal_y+10), dl, fill=hex2rgb(dc), font=F(14), anchor="mt")

    # 6月のカレンダー（2026年6月1日は月曜日）
    # 1日 = 1(月)
    import calendar
    first_dow = 1  # Monday=1, Sunday=0
    month_days = 30
    # 日曜始まりに変換
    # first_dow_sun: 日曜=0, 月曜=1...
    first_dow_sun = first_dow  # 月曜日 → 1
    row_y = cal_y + 38
    col_start = first_dow_sun
    col = col_start
    row = 0

    # 申請済み・選択日
    existing_dates = {9, 10}   # グレー（申請済）
    selected_dates = {16, 17}  # 青塗り（選択中）
    today_day = 9

    for day in range(1, month_days+1):
        cx = cal_left + col*cell_w + cell_w//2
        cy = row_y + row*48 + 24
        r_cell = 16

        if day in selected_dates:
            bg_c = CLR_BLUE; fg_c = "#ffffff"; border_c = CLR_BLUE
        elif day in existing_dates:
            bg_c = "#e5e7eb"; fg_c = "#9ca3af"; border_c = "#e5e7eb"
        else:
            bg_c = BG_WHITE; fg_c = CLR_DGRAY; border_c = "#e5e7eb"

        if day == today_day:
            border_c = "#f59e0b"
            lw = 2
        else:
            lw = 1

        draw.ellipse([cx-r_cell, cy-r_cell, cx+r_cell, cy+r_cell],
                     fill=hex2rgb(bg_c), outline=hex2rgb(border_c))
        draw.text((cx, cy), str(day), fill=hex2rgb(fg_c), font=F(15), anchor="mm")

        col += 1
        if col == 7:
            col = 0
            row += 1

    # グレー凡例
    legend_y = row_y + (row+1)*48 + 10
    draw.text((36, legend_y), "グレーの日付は申請済みです", fill=hex2rgb(CLR_LGRAY), font=F(13))

    # 有効残日数
    remain_y = legend_y + 30
    draw.text((36, remain_y), "有効残日数：10日", fill=hex2rgb(CLR_GREEN_TXT), font=F(16))

    # 有給の期限表示
    expire_y = remain_y + 36
    draw.line([36, expire_y, W-36, expire_y], fill=hex2rgb("#e5e7eb"), width=1)
    draw.text((36, expire_y+8), "有給の期限", fill=hex2rgb("#92400e"), font=F(13))
    draw.rounded_rectangle([36, expire_y+28, W-36, expire_y+58], radius=4,
                            fill=hex2rgb("#fef3c7"))
    draw.text((50, expire_y+43), "1回目：2027年3月31日まで  (残10日)", fill=hex2rgb("#92400e"), font=F(13), anchor="lm")

    # ボタン行
    btn_y = expire_y + 72
    draw.rounded_rectangle([36, btn_y, 36+300, btn_y+52], radius=2,
                            fill=hex2rgb(CLR_BLUE))
    draw.text((36+150, btn_y+26), "申請する", fill=hex2rgb("#ffffff"), font=F(20), anchor="mm")
    draw.rounded_rectangle([36+308, btn_y, W-36, btn_y+52], radius=2,
                            fill=hex2rgb("#dde1e7"), outline=hex2rgb(CLR_LGRAY), width=1)
    draw.text(((36+308+W-36)//2, btn_y+26), "キャンセル", fill=hex2rgb(CLR_GRAY), font=F(17), anchor="mm")

    # ── アノテーション ──
    # ①カレンダーエリア
    cal_box_y1 = cal_y + 38
    cal_box_y2 = row_y + (row+1)*48
    annotation_rect(draw, [30, cal_box_y1-4, W-30, cal_box_y2], lw=3)
    annotation_circle(draw, 30, cal_box_y1-4, 1, font=F(14))

    # ②申請するボタン
    annotation_rect(draw, [34, btn_y-2, 36+302, btn_y+54], color="#0ea5e9", lw=3)
    annotation_circle(draw, 36+302+16, btn_y+26, 2, r=16, font=F(14))

    # 凡例
    fn_y = H - 100
    draw.rectangle([0, fn_y, W, H], fill=hex2rgb("#f8fafc"))
    draw.line([0, fn_y, W, fn_y], fill=hex2rgb(CLR_LGRAY), width=1)
    draw.text((30, fn_y+14), "① カレンダーで有給を取りたい日をタップして選ぶ（複数選択可）", fill=hex2rgb(CLR_DGRAY), font=F(13))
    draw.text((30, fn_y+38), "   青くなった日が選択状態です", fill=hex2rgb(CLR_DGRAY), font=F(13))
    draw.text((30, fn_y+62), "② 日付を確認して「申請する」ボタンをタップする", fill=hex2rgb(CLR_DGRAY), font=F(13))

    img.save(os.path.join(OUT_DIR, "step4_calendar.png"))
    print("step4_calendar.png saved")

# ============================================================
# 画面5: 申請完了メッセージ
# ============================================================
def make_step5_submitted():
    W, H = 600, 500
    img, draw = make_canvas(W, H, BG_APP)

    # モーダル風アラート
    draw.rounded_rectangle([60, 120, W-60, 360], radius=2,
                            fill=hex2rgb(BG_WHITE), outline=hex2rgb(CLR_LGRAY), width=1)
    draw.text((W//2, 190), "有給申請を送信しました", fill=hex2rgb(CLR_DGRAY), font=F(22), anchor="mt")
    draw.text((W//2, 240), "（2026-06-16, 2026-06-17）", fill=hex2rgb(CLR_GRAY), font=F(16), anchor="mt")

    # OK ボタン
    draw.rounded_rectangle([100, 290, W-100, 340], radius=2, fill=hex2rgb(CLR_BLUE))
    draw.text((W//2, 315), "OK", fill=hex2rgb("#ffffff"), font=F(20), anchor="mm")

    # アノテーション
    annotation_rect(draw, [58, 118, W-58, 362], lw=3, color="#059669")
    annotation_circle(draw, W-58+16, 120, 1, r=16, font=F(14))

    # 凡例
    draw.rectangle([0, H-80, W, H], fill=hex2rgb("#f8fafc"))
    draw.line([0, H-80, W, H-80], fill=hex2rgb(CLR_LGRAY), width=1)
    draw.text((30, H-62), "① 「有給申請を送信しました」と表示されたら申請完了です", fill=hex2rgb(CLR_DGRAY), font=F(13))
    draw.text((30, H-38), "   「OK」を押して画面を閉じる", fill=hex2rgb(CLR_DGRAY), font=F(13))

    img.save(os.path.join(OUT_DIR, "step5_submitted.png"))
    print("step5_submitted.png saved")

# ============================================================
# 画面6: 申請後の状態表示（申請中・承認済み）
# ============================================================
def make_step6_status():
    W, H = 600, 700
    img, draw = make_canvas(W, H, BG_APP)

    # カード背景
    draw.rounded_rectangle([20, 20, W-20, H-20], radius=2,
                            fill=hex2rgb(BG_WHITE), outline=hex2rgb(CLR_LGRAY), width=1)
    draw.text((36, 36), "申請状態の種類", fill=hex2rgb(CLR_DGRAY), font=F(20))
    draw.line([36, 68, W-36, 68], fill=hex2rgb("#e9ecef"), width=1)

    statuses = [
        ("申請中",   "#fef9c3", "#ca8a04", "#92400e",
         "管理者が確認・承認待ちの状態です。\nまだ確定ではありません。"),
        ("承認済み", "#d1fae5", "#059669", "#065f46",
         "管理者が承認しました。\n有給取得が確定しました。"),
        ("却下",     "#fee2e2", "#ef4444", "#991b1b",
         "申請が却下されました。\n理由は管理者に確認してください。"),
        ("取消済み", "#f1f5f9", "#64748b", "#334155",
         "申請が取り消されました。\n必要な場合は再申請してください。"),
    ]

    sy = 86
    for label, bg, badge_bg, txt_c, desc in statuses:
        draw.rounded_rectangle([36, sy, W-36, sy+86], radius=4, fill=hex2rgb(bg))
        # バッジ
        bw = len(label)*16 + 24
        draw.rounded_rectangle([50, sy+14, 50+bw, sy+44], radius=3, fill=hex2rgb(badge_bg))
        draw.text((50+bw//2, sy+29), label, fill="#ffffff", font=F(16), anchor="mm")
        # 説明
        for li, line in enumerate(desc.split("\n")):
            draw.text((50+bw+12, sy+18+li*22), line, fill=hex2rgb(txt_c), font=F(14))
        sy += 100

    # 凡例
    draw.rectangle([0, H-80, W, H], fill=hex2rgb("#f8fafc"))
    draw.line([0, H-80, W, H-80], fill=hex2rgb(CLR_LGRAY), width=1)
    draw.text((30, H-62), "申請後は管理者が承認するまで「申請中」になります", fill=hex2rgb(CLR_DGRAY), font=F(13))
    draw.text((30, H-38), "「承認済み」になったら有給取得が確定です", fill=hex2rgb(CLR_DGRAY), font=F(13))

    img.save(os.path.join(OUT_DIR, "step6_status.png"))
    print("step6_status.png saved")

# ============================================================
# 画面7: タイトルページ用ヘッダー画像
# ============================================================
def make_title_banner():
    W, H = 800, 200
    img, draw = make_canvas(W, H, CLR_BLUE)

    draw.text((W//2, 52), "有給申請マニュアル", fill="#ffffff", font=F(56), anchor="mt")
    draw.text((W//2, 124), "申請者向け", fill="#bfdbfe", font=F(30), anchor="mt")
    draw.text((W//2, 162), "株式会社 穂乃味", fill="#dbeafe", font=F(20), anchor="mt")

    img.save(os.path.join(OUT_DIR, "title_banner.png"))
    print("title_banner.png saved")

# ============================================================
# メイン
# ============================================================
if __name__ == "__main__":
    make_title_banner()
    make_step1_home()
    make_step2_pin()
    make_step3_punch()
    make_step4_calendar()
    make_step5_submitted()
    make_step6_status()
    print("\nAll images generated successfully.")
