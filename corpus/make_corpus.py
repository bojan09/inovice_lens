#!/usr/bin/env python3
"""Builds the SYNTHETIC evaluation corpus: documents in corpus/docs/ (git-ignored, regenerate any time) and
ground truth in corpus/truth/ (committed). Truth is written from the data the document is drawn from, never
from OCR output. Everything is invented. This is NOT real-world data: it varies layout, labels, fonts, number
formats, currencies and image quality, but all documents come from this one generator.
Usage: python3 -I corpus/make_corpus.py   (needs Pillow; Liberation/DejaVu fonts)"""
import json, os, random, io
from decimal import Decimal, ROUND_HALF_UP
from PIL import Image, ImageDraw, ImageFont, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
DOCS = os.path.join(HERE, 'docs'); TRUTH = os.path.join(HERE, 'truth')
FD = '/usr/share/fonts/truetype/'
FONTS = {'sans': (FD + 'liberation/LiberationSans-Regular.ttf', FD + 'liberation/LiberationSans-Bold.ttf'),
         'serif': (FD + 'liberation/LiberationSerif-Regular.ttf', FD + 'liberation/LiberationSerif-Bold.ttf'),
         'mono': (FD + 'liberation/LiberationMono-Regular.ttf', FD + 'liberation/LiberationMono-Bold.ttf'),
         'dejavu': (FD + 'dejavu/DejaVuSans.ttf', FD + 'dejavu/DejaVuSans-Bold.ttf')}
def F(fam, size, bold=False): return ImageFont.truetype(FONTS[fam][1 if bold else 0], size)

SUPPLIERS = ['Northwind Traders', 'Blue Harbor Supplies', 'Kestrel Office Goods', 'Maple Street Print Shop', 'Orion Tech Services', 'Fernhill Catering Ltd', 'Quartz Logistics', 'Linden & Pike Studio']
CUSTOMERS = ['Greenfield Holdings', 'Harbor View Hotel', 'Atlas Engineering Ltd', 'Summit Dental Clinic', 'Riverside Bakery', 'Delta Media Group', 'Pinecrest Academy']
ITEMS = ['Office chair', 'USB-C cable 2m', 'Consulting (hours)', 'Printer paper A4', 'Website hosting', 'Monitor stand', 'Cleaning service', 'Software licence', 'Delivery fee', 'Desk lamp', 'Training session', 'Maintenance visit', 'Toner cartridge', 'Wireless mouse']
STORES = ['CORNER MARKET', 'FRESH BITE CAFE', 'CITY PHARMACY', 'GREEN GROCER', 'HARDWARE HUB']
GOODS = ['Milk 1L', 'Bread', 'Coffee', 'Apples 1kg', 'Batteries AA', 'Notebook', 'Sandwich', 'Orange juice', 'Soap', 'Tape roll']
MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
CUR = {'EUR': '€', 'USD': '$', 'GBP': '£'}

def q2(x): return int(Decimal(x).quantize(Decimal('1'), rounding=ROUND_HALF_UP))  # half away from zero for positives

def money(minor, cur, style, group=False):
    s = f'{minor // 100:,}' if group else str(minor // 100)
    s += f'.{minor % 100:02d}'
    if style == 'sym' and cur in CUR: return CUR[cur] + s
    if style == 'prefix': return f'{cur} {s}'
    if style == 'suffix': return f'{s} {cur}'
    return s

def date_text(iso, style):
    y, m, d = iso.split('-'); m_i = int(m); d_i = int(d)
    if style == 'dmy': return f'{d} {MONTHS[m_i-1]} {y}'
    if style == 'mdy': return f'{MONTHS[m_i-1]} {d_i}, {y}'
    if style == 'num' and d_i > 12: return f'{d}/{m}/{y}'
    return iso

def rand_date(r, lo_m=1):
    y = r.choice([2025, 2026]); m = r.randint(lo_m, 12); d = r.randint(1, 28)
    return f'{y:04d}-{m:02d}-{d:02d}'
def add_days(iso, n):
    import datetime as dt
    return (dt.date.fromisoformat(iso) + dt.timedelta(days=n)).isoformat()

def make_invoice(r, i):
    cur = r.choice(['EUR', 'EUR', 'USD', 'GBP'])
    rate = r.choice(['0', '5', '7.5', '10', '18', '20'])
    rows = []
    for _ in range(r.randint(1, 6)):
        qty = r.choice(['1', '1', '2', '3', '5', '10', '1.5', '0.5', '4'])
        unit = r.choice([r.randint(150, 9999), r.randint(10000, 250000)])
        rows.append({'description': r.choice(ITEMS), 'qty': qty, 'unitMinor': unit, 'totalMinor': q2(Decimal(unit) * Decimal(qty))})
    sub = sum(x['totalMinor'] for x in rows)
    tax = q2(Decimal(sub) * Decimal(rate) / 100)
    issue = rand_date(r)
    return {'docType': 'invoice', 'cur': cur, 'supplier': r.choice(SUPPLIERS), 'customer': r.choice(CUSTOMERS),
            'number': r.choice([f'INV-2026-{r.randint(1,999):04d}', f'#{r.randint(10000,99999)}', f'{r.randint(2025,2026)}/{r.randint(1,200):03d}', f'A{r.randint(100,999)}-{r.randint(10,99)}']),
            'issue': issue, 'due': r.choice([None, add_days(issue, 14), add_days(issue, 30)]), 'rate': rate,
            'rows': rows, 'sub': sub, 'tax': tax, 'total': sub + tax}

def make_receipt(r, i):
    cur = r.choice(['EUR', 'USD', 'GBP', None])
    rows = [{'description': g, 'totalMinor': r.randint(60, 2500)} for g in r.sample(GOODS, r.randint(2, 6))]
    sub = sum(x['totalMinor'] for x in rows)
    rate = r.choice(['0', '8', '10'])
    tax = q2(Decimal(sub) * Decimal(rate) / 100)
    return {'docType': 'receipt', 'cur': cur, 'supplier': r.choice(STORES), 'issue': rand_date(r), 'rows': rows, 'sub': sub, 'tax': tax, 'rate': rate, 'total': sub + tax}

# ------------------------------------------------------------------ layouts (return image, transcript lines)
class Page:
    def __init__(s, w, h): s.im = Image.new('RGB', (w, h), 'white'); s.d = ImageDraw.Draw(s.im); s.lines = []
    def t(s, x, y, text, font, fill=(15, 15, 15), right=False):
        if right: x = x - s.d.textlength(text, font=font)
        s.d.text((x, y), text, font=font, fill=fill); s.lines.append(text)

def layout_invoice(D, r, style):
    fam = {'A': 'sans', 'B': 'dejavu', 'C': 'serif', 'D': 'sans'}[style]
    P = Page(1240, 1754); cur = D['cur']; ms = r.choice(['sym', 'prefix', 'suffix', 'plain']) if cur else 'plain'
    group = r.random() < 0.5
    ds = r.choice(['iso', 'dmy', 'mdy', 'num'])
    D['shows_cur'] = ms != 'plain'
    fm = lambda v: money(v, cur, ms, group)
    plain = lambda v: money(v, cur, 'plain', group)
    cx = [100, 640, 790, 1000]
    if style == 'A':
        P.t(90, 90, D['supplier'], F(fam, 52, True)); P.t(90, 160, '12 Market Street, Springfield', F(fam, 28))
        P.t(820, 90, 'INVOICE', F(fam, 60, True))
        P.t(820, 190, f"Invoice No: {D['number']}", F(fam, 30)); P.t(820, 240, f"Date: {date_text(D['issue'], ds)}", F(fam, 30))
        if D['due']: P.t(820, 290, f"Due Date: {date_text(D['due'], ds)}", F(fam, 30))
        P.t(90, 330, 'Bill to:', F(fam, 32, True)); P.t(90, 380, D['customer'], F(fam, 30)); P.t(90, 430, '45 Industrial Ave', F(fam, 30))
        heads = ['Description', 'Qty', 'Unit Price', 'Total']; lab = [('Subtotal', 'sub'), (f"Tax ({D['rate']}%)", 'tax'), ('Total', 'total')]
    elif style == 'B':
        P.t(620, 70, 'TAX INVOICE', F(fam, 46, True), right=False); P.t(90, 150, D['supplier'], F(fam, 40, True)); P.t(90, 205, 'Unit 4, Park Road', F(fam, 26))
        P.t(90, 300, f"Invoice #: {D['number']}", F(fam, 28)); P.t(90, 345, f"Issued: {date_text(D['issue'], ds)}", F(fam, 28))
        if D['due']: P.t(90, 390, f"Payment due: {date_text(D['due'], ds)}", F(fam, 28))
        P.t(700, 300, f"Billed to: {D['customer']}", F(fam, 28))
        heads = ['Item', 'Quantity', 'Price', 'Amount']; cx = [100, 600, 780, 990]
        lab = [('Sub Total', 'sub'), (f"VAT ({D['rate']}%)", 'tax'), ('Amount Due', 'total')]
    elif style == 'C':
        P.t(90, 80, D['supplier'], F(fam, 54, True)); P.t(850, 90, 'Invoice', F(fam, 56, True))
        P.t(850, 180, f"Invoice Number: {D['number']}", F(fam, 28)); P.t(850, 225, f"Date of issue: {date_text(D['issue'], ds)}", F(fam, 28))
        if D['due']: P.t(850, 270, f"Due on: {date_text(D['due'], ds)}", F(fam, 28))
        P.t(90, 330, f"Customer: {D['customer']}", F(fam, 30))
        heads = ['Description', 'Qty', 'Unit price', 'Total']; cx = [100, 620, 770, 990]
        lab = [('Subtotal', 'sub'), (f"Tax {D['rate']}%", 'tax'), ('Total due', 'total')]
    else:  # D: compact, right-aligned numbers, small font
        P.t(90, 90, D['supplier'], F(fam, 40, True)); P.t(1150, 90, 'INVOICE', F(fam, 44, True), right=True)
        P.t(1150, 150, f"No. {D['number']}", F(fam, 26), right=True); P.t(1150, 190, f"Date: {date_text(D['issue'], ds)}", F(fam, 26), right=True)
        if D['due']: P.t(1150, 230, f"Due Date: {date_text(D['due'], ds)}", F(fam, 26), right=True)
        P.t(90, 300, 'Bill to:', F(fam, 28, True)); P.t(90, 340, D['customer'], F(fam, 28))
        heads = ['Description', 'Qty', 'Unit Price', 'Total']; cx = [100, 560, 760, 960]
        lab = [('Subtotal', 'sub'), (f"Tax ({D['rate']}%)", 'tax'), ('Total', 'total')]
    fs = 28 if style != 'D' else 25
    y = 520 if style in ('A', 'D') else 480
    P.d.line((90, y, 1150, y), fill=(0, 0, 0), width=3)
    for x, h in zip(cx, heads): P.t(x, y + 12, h, F(fam, fs, True))
    P.d.line((90, y + 56, 1150, y + 56), fill=(0, 0, 0), width=2)
    right_edge = 1140
    for k, row in enumerate(D['rows']):
        yy = y + 76 + k * 54
        P.t(cx[0], yy, row['description'], F(fam, fs)); P.t(cx[1], yy, row['qty'], F(fam, fs))
        P.t(cx[2] + 130, yy, fm(row['unitMinor']), F(fam, fs), right=True); P.t(right_edge, yy, fm(row['totalMinor']), F(fam, fs), right=True)
    yy = y + 76 + len(D['rows']) * 54 + 40
    for j, (label, key) in enumerate(lab):
        big = j == 2
        P.t(700, yy + j * 52, label, F(fam, fs + (4 if big else 0), big)); P.t(right_edge, yy + j * 52, fm(D[key]), F(fam, fs + (4 if big else 0), big), right=True)
    P.t(90, yy + 220, 'Thank you for your business.', F(fam, 26), fill=(70, 70, 70))
    return P

def layout_receipt(D, r, style):
    fam = 'mono' if style == 'A' else 'sans'
    P = Page(640, 1000 + 40 * len(D['rows'])); cur = D['cur']; ms = r.choice(['sym', 'plain']) if cur else 'plain'
    D['shows_cur'] = ms != 'plain'
    fm = lambda v: money(v, cur, ms)
    P.t(120, 40, D['supplier'], F(fam, 40, True)); P.t(150, 100, '5 High Street', F(fam, 26))
    ds = r.choice(['iso', 'num']); dt = date_text(D['issue'], ds)
    P.t(40, 170, f"Date: {dt} {r.randint(8,21):02d}:{r.randint(10,59)}", F(fam, 26)); P.t(40, 210, f"Cashier: {r.randint(1,9)}", F(fam, 26))
    y = 280
    for row in D['rows']:
        P.t(40, y, row['description'], F(fam, 28)); P.t(600, y, fm(row['totalMinor']), F(fam, 28), right=True); y += 46
    y += 20; P.d.line((40, y, 600, y), fill=(0, 0, 0), width=2); y += 20
    P.t(40, y, 'SUBTOTAL', F(fam, 28)); P.t(600, y, fm(D['sub']), F(fam, 28), right=True); y += 46
    P.t(40, y, f"TAX {D['rate']}%", F(fam, 28)); P.t(600, y, fm(D['tax']), F(fam, 28), right=True); y += 52
    P.t(40, y, 'TOTAL', F(fam, 36, True)); P.t(600, y, fm(D['total']), F(fam, 36, True), right=True); y += 80
    P.t(40, y, 'VISA **** 4821', F(fam, 26)); P.t(110, y + 60, 'Thank you for shopping', F(fam, 28))
    return P

def degrade(im, r, kind):
    if kind == 'clean': return im, 'png'
    w, h = im.size
    im = im.rotate(r.uniform(-1.8, 1.8), resample=Image.BICUBIC, expand=True, fillcolor=(255, 255, 255))
    if kind == 'photo':
        # soft shadow gradient + warm cast + blur + noise, shrunk like a phone photo, then JPEG
        grad = Image.linear_gradient('L').resize(im.size).rotate(r.choice([0, 90, 180, 270]))
        shade = Image.merge('RGB', [grad.point(lambda v: int(205 + v * 50 / 255))] * 3)
        from PIL import ImageChops
        im = ImageChops.multiply(im, shade)
        im = im.filter(ImageFilter.GaussianBlur(r.uniform(0.6, 1.1)))
        px = im.load(); rr = random.Random(r.random())
        for yy in range(0, im.size[1]):
            for xx in range(0, im.size[0], 1):
                if rr.random() < 0.02:
                    n = rr.randint(-25, 25); p = px[xx, yy]; px[xx, yy] = tuple(max(0, min(255, c + n)) for c in p)
        sc = r.uniform(0.7, 0.9); im = im.resize((int(im.size[0] * sc), int(im.size[1] * sc)), Image.LANCZOS)
    return im, 'jpg'

def keyed_truth(D, doc_id, kind):
    # truth is what the PAGE shows: when no currency symbol/code is printed, the currency is unknown (null)
    D = dict(D, cur=D['cur'] if D.get('shows_cur') else None)
    t = {'docType': D['docType'], 'language': 'en', 'source': 'synthetic',
         'keyedBy': 'corpus/make_corpus.py (written from the generator data, not from OCR)',
         'supplier': {'name': D['supplier']}, 'number': D.get('number'), 'issueDate': D['issue'], 'dueDate': D.get('due'),
         'currency': D['cur'], 'taxRatePercent': D['rate'], 'subtotalMinor': D['sub'], 'taxMinor': D['tax'], 'totalMinor': D['total'],
         'rows': [{'description': x['description'], 'qty': x.get('qty'), 'unitMinor': x.get('unitMinor'), 'totalMinor': x['totalMinor']} for x in D['rows']]}
    if 'customer' in D: t['customer'] = {'name': D['customer']}
    return t

def main(n_invoice=24, n_receipt=10, seed=20261103):
    os.makedirs(DOCS, exist_ok=True); os.makedirs(TRUTH, exist_ok=True)
    for f in os.listdir(TRUTH):
        if f.startswith('syn-') and f.endswith('.json'): os.remove(os.path.join(TRUTH, f))
    r = random.Random(seed); plan = []
    for i in range(n_invoice): plan.append(('invoice', 'ABCD'[i % 4], ['clean', 'clean', 'photo'][i % 3]))
    for i in range(n_receipt): plan.append(('receipt', 'AB'[i % 2], ['clean', 'photo'][i % 2]))
    for i, (kind, style, deg) in enumerate(plan, 1):
        D = make_invoice(r, i) if kind == 'invoice' else make_receipt(r, i)
        P = layout_invoice(D, r, style) if kind == 'invoice' else layout_receipt(D, r, style)
        im, ext = degrade(P.im, r, deg)
        doc_id = f'syn-{kind[:3]}-{i:02d}-{style.lower()}-{deg}'
        path = os.path.join(DOCS, f'{doc_id}.{ext}')
        im.save(path, quality=62 if ext == 'jpg' else None) if ext == 'jpg' else im.save(path)
        t = keyed_truth(D, doc_id, f'{kind} layout {style}, {deg}')
        t['transcript'] = '\n'.join(P.lines)
        with open(os.path.join(TRUTH, f'{doc_id}.json'), 'w') as fh: json.dump(t, fh, indent=1)
    print(f'{len(plan)} documents -> {DOCS}')

if __name__ == '__main__': main()
