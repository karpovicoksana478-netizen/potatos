import glob, os, sys
import esprima

os.chdir(os.path.dirname(os.path.abspath(__file__)))
bad = 0
for path in sorted(glob.glob("static/*.js")):
    src = open(path, encoding="utf-8").read()
    try:
        esprima.parseScript(src)
        print("OK  ", path)
    except Exception as e:
        bad += 1
        line = getattr(e, "lineNumber", "?")
        col = getattr(e, "column", "?")
        print("FAIL", path, "line", line, "col", col, "->", e)
sys.exit(1 if bad else 0)
