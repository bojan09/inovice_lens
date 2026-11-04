import sys, json, time
from selenium import webdriver
from selenium.webdriver.common.by import By
o = webdriver.WebKitGTKOptions()
o.binary_location = "/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/MiniBrowser"
o.add_argument("--automation")
d = webdriver.WebKitGTK(options=o)
try:
    d.get("http://127.0.0.1:5199/")
    time.sleep(2)
    print("UA", d.execute_script("return navigator.userAgent"))
    print("title", d.title)
    print("modules ok", d.execute_script("return typeof document.querySelector('main, #app') !== 'undefined'"))
    print("body chars", len(d.find_element(By.TAG_NAME, "body").text))
    print("hash route ->", d.execute_script("location.hash='#/settings'; return location.hash"))
    time.sleep(1)
    print("settings text", d.find_element(By.TAG_NAME, "main").text[:80].replace("\n"," | "))
    print("indexedDB", d.execute_script("return typeof indexedDB"), "sw", d.execute_script("return 'serviceWorker' in navigator"), "wasm", d.execute_script("return typeof WebAssembly"), "OffscreenCanvas", d.execute_script("return typeof OffscreenCanvas"))
    print("console errors:", d.execute_script("return window.__errs||null"))
    d.save_screenshot("/tmp/wk.png")
finally:
    d.quit()
