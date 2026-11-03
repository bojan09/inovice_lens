#!/usr/bin/env python3
"""Regenerates the synthetic Phase 2 fixtures. All content is invented; nothing is a real document.
Usage: python3 -I tests/fixtures/make_fixtures.py   (needs Pillow and the Liberation Sans fonts)"""
import io, os, random, zlib
from PIL import Image, ImageDraw, ImageFont, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
REG = '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf'
BOLD = '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf'
def font(size, bold=False): return ImageFont.truetype(BOLD if bold else REG, size)

def invoice_page(w=1240, h=1754):
    im = Image.new('RGB', (w, h), 'white'); d = ImageDraw.Draw(im)
    d.text((90, 90), 'ACME Supplies', font=font(54, True), fill=(10, 20, 40))
    d.text((90, 160), '12 Market Street, 1000 Skopje, MK', font=font(30), fill=(40, 40, 40))
    d.text((820, 90), 'INVOICE', font=font(64, True), fill=(10, 20, 40))
    d.text((820, 190), 'Invoice No: INV-00482', font=font(32), fill=(20, 20, 20))
    d.text((820, 240), 'Date: 03 Nov 2026', font=font(32), fill=(20, 20, 20))
    d.text((820, 290), 'Due Date: 17 Nov 2026', font=font(32), fill=(20, 20, 20))
    d.text((90, 330), 'Bill to:', font=font(34, True), fill=(20, 20, 20))
    d.text((90, 380), 'Bright Tech Ltd', font=font(32), fill=(20, 20, 20))
    d.text((90, 430), '45 Industrial Ave, 1000 Skopje', font=font(32), fill=(20, 20, 20))
    y = 560
    d.line((90, y, 1150, y), fill=(0, 0, 0), width=3)
    for x, t in [(100, 'Description'), (640, 'Qty'), (780, 'Unit Price'), (1000, 'Total')]:
        d.text((x, y + 14), t, font=font(32, True), fill=(0, 0, 0))
    d.line((90, y + 68, 1150, y + 68), fill=(0, 0, 0), width=2)
    rows = [('Product A', '2', '80.00', '160.00'), ('Product B', '1', '85.00', '85.00')]
    for i, r in enumerate(rows):
        yy = y + 90 + i * 60
        for x, t in zip((100, 660, 800, 1010), r): d.text((x, yy), t, font=font(32), fill=(0, 0, 0))
    d.text((780, 840), 'Subtotal  245.00', font=font(34), fill=(0, 0, 0))
    d.text((780, 895), 'Tax (0%)  0.00', font=font(34), fill=(0, 0, 0))
    d.text((780, 960), 'Total EUR 245.00', font=font(40, True), fill=(0, 0, 0))
    d.text((90, 1100), 'Payment terms: 14 days. Thank you for your business.', font=font(30), fill=(60, 60, 60))
    return im

def receipt_page(w=700, h=1100):
    im = Image.new('RGB', (w, h), 'white'); d = ImageDraw.Draw(im)
    d.text((170, 50), 'CORNER STORE', font=font(48, True), fill=(0, 0, 0))
    d.text((190, 120), 'Receipt', font=font(36), fill=(0, 0, 0))
    d.text((60, 190), 'Cashier: 4   Terminal: 2', font=font(30), fill=(0, 0, 0))
    for i, (n, p) in enumerate([('Milk 1L', '1.20'), ('Bread', '2.10'), ('Coffee', '5.40')]):
        d.text((60, 270 + i * 55), n, font=font(34), fill=(0, 0, 0)); d.text((500, 270 + i * 55), p, font=font(34), fill=(0, 0, 0))
    d.text((60, 480), 'Total', font=font(40, True), fill=(0, 0, 0)); d.text((470, 480), '8.70', font=font(40, True), fill=(0, 0, 0))
    d.text((60, 560), 'VISA **** 1234', font=font(32), fill=(0, 0, 0))
    d.text((60, 610), 'Cash tendered 10.00   Change 1.30', font=font(30), fill=(0, 0, 0))
    d.text((120, 720), 'Thank you for shopping', font=font(34), fill=(0, 0, 0))
    return im

def table_page(w=1240, h=900):
    im = Image.new('RGB', (w, h), 'white'); d = ImageDraw.Draw(im)
    heads = ['Product', 'Jan', 'Feb', 'Mar']
    rows = [['Widget', '10', '20', '30'], ['Gadget', '15', '25', '35'], ['Gizmo', '20', '30', '40'], ['Sprocket', '5', '6', '7'], ['Totals', '50', '81', '112']]
    xs = [100, 560, 760, 960]
    for x, t in zip(xs, heads): d.text((x, 100), t, font=font(36, True), fill=(0, 0, 0))
    d.line((90, 160, 1150, 160), fill=(0, 0, 0), width=3)
    for i, r in enumerate(rows):
        for x, t in zip(xs, r): d.text((x, 190 + i * 70), t, font=font(36), fill=(0, 0, 0))
    return im

def jpeg_bytes(im, q=85):
    b = io.BytesIO(); im.save(b, 'JPEG', quality=q); return b.getvalue()

def image_pdf(pages):
    """PDF whose pages are only JPEG images (a 'scanned' PDF: no text layer)."""
    objs = []; kids = []
    n = 3
    parts = []
    for im in pages:
        jb = jpeg_bytes(im); w, h = im.size
        pw, ph = 595, round(595 * h / w)
        img, cont, page = n, n + 1, n + 2; n += 3
        kids.append(page)
        parts.append((img, b'<< /Type /XObject /Subtype /Image /Width %d /Height %d /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length %d >>\nstream\n' % (w, h, len(jb)) + jb + b'\nendstream'))
        c = b'q %d 0 0 %d 0 0 cm /Im0 Do Q' % (pw, ph)
        parts.append((cont, b'<< /Length %d >>\nstream\n' % len(c) + c + b'\nendstream'))
        parts.append((page, b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %d %d] /Contents %d 0 R /Resources << /XObject << /Im0 %d 0 R >> >> >>' % (pw, ph, cont, img)))
    objmap = {1: b'<< /Type /Catalog /Pages 2 0 R >>', 2: b'<< /Type /Pages /Kids [%s] /Count %d >>' % (b' '.join(b'%d 0 R' % k for k in kids), len(kids))}
    for i, body in parts: objmap[i] = body
    return write_pdf(objmap)

def text_pdf(pages_lines):
    objmap = {1: b'<< /Type /Catalog /Pages 2 0 R >>'}
    kids = []; n = 4
    objmap[3] = b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
    for lines in pages_lines:
        ops = b'BT /F1 14 Tf 18 TL 50 780 Td ' + b' '.join(b'(' + l.replace('(', r'\(').replace(')', r'\)').encode('latin-1') + b') Tj T*' for l in lines) + b' ET'
        cont, page = n, n + 1; n += 2; kids.append(page)
        objmap[cont] = b'<< /Length %d >>\nstream\n' % len(ops) + ops + b'\nendstream'
        objmap[page] = b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents %d 0 R /Resources << /Font << /F1 3 0 R >> >> >>' % cont
    objmap[2] = b'<< /Type /Pages /Kids [%s] /Count %d >>' % (b' '.join(b'%d 0 R' % k for k in kids), len(kids))
    return write_pdf(objmap)

def write_pdf(objmap):
    out = b'%PDF-1.4\n%\xe2\xe3\xcf\xd3\n'; offs = {}
    for i in sorted(objmap):
        offs[i] = len(out); out += b'%d 0 obj\n' % i + objmap[i] + b'\nendobj\n'
    size = max(objmap) + 1; x = len(out)
    out += b'xref\n0 %d\n0000000000 65535 f \n' % size
    for i in range(1, size): out += b'%010d 00000 n \n' % offs[i]
    return out + b'trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n' % (size, x)

def save(name, data):
    open(os.path.join(HERE, name), 'wb').write(data)

inv, rec, tab = invoice_page(), receipt_page(), table_page()
inv.save(os.path.join(HERE, 'invoice-scan.png'), optimize=True)
rec.save(os.path.join(HERE, 'receipt-scan.jpg'), quality=88)
tab.save(os.path.join(HERE, 'table-scan.png'), optimize=True)
inv.rotate(-90, expand=True, fillcolor='white').save(os.path.join(HERE, 'invoice-rotated90.png'), optimize=True)  # content turned 90 degrees clockwise
inv.rotate(3, resample=Image.BICUBIC, expand=False, fillcolor='white').save(os.path.join(HERE, 'invoice-skewed.png'), optimize=True)
random.seed(7)
noise = Image.effect_noise((400, 300), 90).convert('RGB'); noise.save(os.path.join(HERE, 'noise.png'), optimize=True)
Image.new('RGB', (800, 600), 'white').save(os.path.join(HERE, 'blank.png'), optimize=True)
# phone-photo-like: low contrast, uneven lighting (shadow gradient), blur, JPEG artefacts
from PIL import ImageEnhance
def photo_like(im):
    im = ImageEnhance.Contrast(im).enhance(0.45)
    w, h = im.size
    shade = Image.linear_gradient('L').resize((w, h)).rotate(0)          # 0 (top) .. 255 (bottom)
    shade = shade.point(lambda v: int(120 + v * 0.47))                   # 120..240 : strong top shadow
    im = Image.composite(im, Image.new('RGB', (w, h), (0, 0, 0)), shade) # darken by gradient
    im = im.filter(ImageFilter.GaussianBlur(2.2))
    b = io.BytesIO(); im.save(b, 'JPEG', quality=45); return Image.open(io.BytesIO(b.getvalue())).convert('RGB')
photo_like(inv).save(os.path.join(HERE, 'invoice-lowcontrast.png'), optimize=True)
save('scanned-2page.pdf', image_pdf([inv, rec]))
save('invoice-text.pdf', text_pdf([
    ['ACME Supplies', 'INVOICE', 'Invoice No: INV-00482', 'Date: 03 Nov 2026', 'Due Date: 17 Nov 2026', 'Bill to: Bright Tech Ltd',
     'Description Qty Unit Price Total', 'Product A 2 80.00 160.00', 'Product B 1 85.00 85.00', 'Subtotal 245.00', 'Tax (0%) 0.00', 'Total EUR 245.00'],
    ['Page two', 'Payment terms: 14 days.', 'Thank you for your business.', 'Supplier bank: SYNTHETIC-IBAN-0000']]))
# genuinely password-protected PDF (needs pypdf): user password 'secret'
try:
    from pypdf import PdfReader, PdfWriter
    w = PdfWriter(); [w.add_page(p) for p in PdfReader(io.BytesIO(text_pdf([['Secret invoice text for encrypted fixture']]))).pages]
    w.encrypt('secret'); b = io.BytesIO(); w.write(b); save('encrypted.pdf', b.getvalue())
except ImportError:
    print('pypdf missing: encrypted.pdf not regenerated')
save('broken.pdf', b'%PDF-1.4\nthis is not a real pdf body\n%%EOF\n')
print('ok')
