# Real WebKit (WebKitGTK) end-to-end smoke: upload a corpus image, OCR it, open the editor.
# Run: node scripts/serve.js 5199 &  xvfb-run -a python tests/webkit/ocr_journey.py   (needs: selenium, webkit2gtk-driver, xvfb)
import os, time, sys
from selenium import webdriver
from selenium.webdriver.common.by import By
HERE = os.path.dirname(os.path.abspath(__file__))
CORPUS_FILE = os.path.join(HERE, "..", "..", "corpus", "docs", "syn-inv-01-a-clean.png")
o = webdriver.WebKitGTKOptions()
o.binary_location = "/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/MiniBrowser"
o.add_argument("--automation")
d = webdriver.WebKitGTK(options=o)
try:
    d.get("http://127.0.0.1:5199/")
    time.sleep(1.5)
    d.find_element(By.ID, "file-input").send_keys(CORPUS_FILE)
    t0 = time.time(); state = None
    while time.time() - t0 < 200:
        cards = d.find_elements(By.CSS_SELECTOR, ".file-card")
        txt = " ".join(c.text for c in cards).lower()
        if cards and any(k in txt for k in ("review", "recognized", "failed")): break
        time.sleep(2)
    print("elapsed %.0fs" % (time.time() - t0))
    print("cards:", [c.text.replace("\n", " | ")[:140] for c in d.find_elements(By.CSS_SELECTOR, ".file-card")])
    links = d.find_elements(By.CSS_SELECTOR, ".file-card a")
    for a in links:
        if "Review" in a.text: a.click(); break
    time.sleep(4)
    vals = d.execute_script("return Object.fromEntries([...document.querySelectorAll('.fld[data-key]')].map(r=>[r.dataset.key,r.querySelector('input').value]))")
    print("fields:", vals)
    d.save_screenshot("/tmp/wk_editor.png")
finally:
    d.quit()
