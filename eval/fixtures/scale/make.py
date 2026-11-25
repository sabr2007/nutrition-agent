"""Synthetic eval photo: candies on a kitchen scale showing 46 g (no personal data).
Run: python3 eval/fixtures/scale/make.py  → eval/fixtures/scale/candy-46g.jpg
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).with_name('candy-46g.jpg')
BOLD = '/System/Library/Fonts/Supplemental/Arial Bold.ttf'
REG = '/System/Library/Fonts/Supplemental/Arial.ttf'

img = Image.new('RGB', (900, 700), (226, 221, 210))
d = ImageDraw.Draw(img)
# Scale body, platform and display.
d.rounded_rectangle((120, 330, 780, 650), radius=40, fill=(245, 245, 242), outline=(170, 170, 165), width=4)
d.rounded_rectangle((170, 300, 730, 360), radius=20, fill=(210, 210, 205), outline=(160, 160, 155), width=3)
d.rounded_rectangle((300, 470, 600, 600), radius=12, fill=(25, 35, 30))
d.text((330, 478), '46', font=ImageFont.truetype(BOLD, 110), fill=(120, 255, 150))
d.text((515, 530), 'g', font=ImageFont.truetype(BOLD, 56), fill=(120, 255, 150))
d.text((330, 612), 'TARE      ON/OFF', font=ImageFont.truetype(REG, 22), fill=(90, 90, 90))
# A small pile of wrapped candies on the platform.
for i, (x, y) in enumerate([(230, 200), (360, 185), (490, 205), (300, 250), (430, 245), (560, 250)]):
    d.rounded_rectangle((x, y, x + 150, y + 70), radius=18, fill=(250, 236, 120), outline=(200, 150, 40), width=3)
    d.text((x + 14, y + 8), 'Рот Фронт', font=ImageFont.truetype(BOLD, 20), fill=(150, 30, 30))
    d.text((x + 14, y + 34), 'РОМАШКА', font=ImageFont.truetype(BOLD, 24), fill=(40, 90, 40))
d.text((120, 40), 'конфеты глазированные «Ромашка», Рот Фронт', font=ImageFont.truetype(REG, 28), fill=(60, 60, 60))
img.save(OUT, 'JPEG', quality=82)
print(OUT, OUT.stat().st_size)
