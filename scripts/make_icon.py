# KOKO アイコンを生成する。文字は Inter ExtraBold（SIL OFL）からアウトライン化して埋め込み、
# どの端末でも同じ形で表示されるようにする。
import sys
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.boundsPen import BoundsPen

font_path = sys.argv[1] if len(sys.argv) > 1 else '/usr/share/fonts/opentype/inter/Inter-ExtraBold.otf'
f = TTFont(font_path)
gs = f.getGlyphSet(); cmap = f.getBestCmap(); upm = f['head'].unitsPerEm
text, size, track = 'KOKO', 60, 0.05
scale = size / upm
x = 0; parts = []; xmin = ymin = 1e9; xmax = ymax = -1e9
for ch in text:
    g = gs[cmap[ord(ch)]]
    pen = SVGPathPen(gs); g.draw(pen)
    bp = BoundsPen(gs); g.draw(bp)
    if bp.bounds:
        a, b, c, d = bp.bounds
        xmin = min(xmin, x + a); xmax = max(xmax, x + c); ymin = min(ymin, b); ymax = max(ymax, d)
    parts.append((x, pen.getCommands()))
    x += g.width + track * upm
w = (xmax - xmin) * scale; hgt = (ymax - ymin) * scale
cx, cy = 256, 268  # ハートの胴の中心付近
ox = cx - w / 2 - xmin * scale
oy = cy + hgt / 2 + ymin * scale  # フォント座標は上向き
paths = ''.join(f'<path transform="translate({ox + px*scale:.2f} {oy:.2f}) scale({scale:.5f} {-scale:.5f})" d="{d}"/>' for px, d in parts)
heart = 'M256 427C209 393 69 296 69 180C69 88 184 65 256 146C328 65 443 88 443 180C443 296 303 393 256 427Z'

def svg(bg=True, maskable=False):
    # 通常: 角丸の正方形。maskable: 全面塗り＋ハートを中央 72% の安全域に収める
    k = 0.76 if maskable else 0.86
    rx = '0' if maskable else '112'
    g = f'<g transform="translate(256 262) scale({k}) translate(-256 -256)"><path d="{heart}" fill="#87D9ED"/></g>'
    tk = k / 0.86
    t = f'<g fill="#244650" transform="translate(256 262) scale({tk:.4f}) translate(-256 -262)">{paths}</g>'
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><title>KOKO</title><rect width="512" height="512" rx="{rx}" fill="#F2FBFE"/>{g}{t}</svg>'

open('public/icons/icon.svg', 'w').write(svg())
open('public/icons/icon-maskable.svg', 'w').write(svg(maskable=True))
print('text box', round(w), round(hgt))
