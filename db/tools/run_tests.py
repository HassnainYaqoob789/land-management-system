#!/usr/bin/env python3
"""Run the LMS database test suite.

Standard library only; it shells out to psql, so no driver is needed.

    db/tools/run_tests.py                       # rebuild lms_test and run all
    db/tools/run_tests.py --no-rebuild          # reuse the existing lms_test
    db/tools/run_tests.py -k rls                # only files matching "rls"
    db/tools/run_tests.py --db lms_scratch

Each file in db/tests/ named test_*.sql is one test. Directives in the first
few lines control how it runs:

    -- role: lms_test | lms_owner | lms_migrator     (default lms_test)
    -- tx:   rollback | commit                       (default rollback)
    -- actor: <username>        set the actor context before the body runs

"rollback" wraps the file in BEGIN … ROLLBACK, so a test cannot leave anything
behind and the files are order-independent. "commit" is for the tests that are
about COMMIT itself — deferred constraint triggers only fire there — and those
files are responsible for their own cleanup.

Assertions come from db/tests/_helpers.sql: test.ok, test.eq, test.throws and
test.throws_like. A failing assertion raises, which fails the file.
"""
import argparse
import os
import re
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TESTS = os.path.join(ROOT, "tests")
DIRECTIVE = re.compile(r"^--\s*(role|tx|actor)\s*:\s*(\S+)", re.I)


def run_psql(db, user, script, echo_notices=True):
    cmd = ["psql", "-v", "ON_ERROR_STOP=1", "--no-psqlrc", "-q", "-At",
           "-U", user, "-d", db, "-f", "-"]
    env = dict(os.environ)
    # NOTICE carries the per-assertion "ok" lines.
    env["PGOPTIONS"] = "-c client_min_messages=notice"
    return subprocess.run(cmd, input=script, capture_output=True, text=True, env=env)


def directives(body):
    d = {"role": "lms_test", "tx": "rollback", "actor": None}
    for line in body.splitlines()[:12]:
        m = DIRECTIVE.match(line.strip())
        if m:
            d[m.group(1).lower()] = m.group(2)
    return d


def build_script(body, d):
    pre = []
    if d["role"] in ("lms_owner",):
        pre.append("SET ROLE lms_owner;")
    if d["actor"]:
        # test.become() resolves the username with definer rights: a session
        # with no actor yet cannot see lms.app_user through row-level security.
        pre.append(f"SELECT test.become('{d['actor']}');")
    head = "\n".join(pre)
    if d["tx"] == "commit":
        return head + "\n" + body
    return "BEGIN;\n" + head + "\n" + body + "\nROLLBACK;\n"


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--db", default=os.environ.get("LMS_TEST_DB", "lms_test"))
    p.add_argument("--no-rebuild", action="store_true")
    p.add_argument("-k", dest="filter", help="only run files whose name contains this")
    p.add_argument("-v", dest="verbose", action="store_true", help="print every assertion")
    a = p.parse_args()

    if not a.no_rebuild:
        print(f"rebuilding {a.db} …", flush=True)
        r = subprocess.run([os.path.join(ROOT, "tools", "rebuild.sh"), a.db, "seed"],
                           capture_output=True, text=True)
        if r.returncode != 0:
            sys.stderr.write(r.stdout + r.stderr)
            sys.exit("could not rebuild the test database")

    with open(os.path.join(TESTS, "_helpers.sql"), encoding="utf-8") as fh:
        r = run_psql(a.db, "lms_migrator", fh.read())
    if r.returncode != 0:
        sys.stderr.write(r.stdout + r.stderr)
        sys.exit("could not install the test helpers")

    files = sorted(f for f in os.listdir(TESTS)
                   if f.startswith("test_") and f.endswith((".sql", ".py"))
                   and (not a.filter or a.filter in f))
    if not files:
        sys.exit("no test files matched")

    passed = failed = asserts = 0
    failures = []
    t0 = time.time()
    for fn in files:
        # A .py test drives several sessions at once, which a single psql
        # script cannot do. It gets the database name through the environment
        # and reports "ok"/"FAIL" lines on stdout in the same shape.
        if fn.endswith(".py"):
            env = dict(os.environ, LMS_TEST_DB=a.db)
            res = subprocess.run([sys.executable, os.path.join(TESTS, fn)],
                                 capture_output=True, text=True, env=env)
            oks = [l for l in res.stdout.splitlines() if l.startswith("ok  ")]
            asserts += len(oks)
            if res.returncode == 0:
                passed += 1
                print(f"PASS  {fn:<42} {len(oks):>3} assertions")
                if a.verbose:
                    for l in oks:
                        print("        " + l)
            else:
                failed += 1
                print(f"FAIL  {fn:<42} {len(oks):>3} assertions passed")
                bad = [l for l in res.stdout.splitlines() if l.startswith("FAIL")]
                failures.append((fn, "\n".join(bad) or res.stderr[-2000:]))
                for l in bad[:6]:
                    print("        " + l)
            continue
        with open(os.path.join(TESTS, fn), encoding="utf-8") as fh:
            body = fh.read()
        d = directives(body)
        user = "lms_migrator" if d["role"] in ("lms_owner", "lms_migrator") else d["role"]
        res = run_psql(a.db, user, build_script(body, d))
        # psql prefixes diagnostics with "psql:<stdin>:NN: ".
        oks = [l for l in res.stderr.splitlines() if "NOTICE:  ok   " in l]
        asserts += len(oks)
        if res.returncode == 0:
            passed += 1
            print(f"PASS  {fn:<42} {len(oks):>3} assertions")
            if a.verbose:
                for l in oks:
                    print("        " + l.replace("NOTICE:  ", ""))
        else:
            failed += 1
            print(f"FAIL  {fn:<42} {len(oks):>3} assertions before the failure")
            msg = [l for l in res.stderr.splitlines()
                   if "ERROR" in l or "FAIL:" in l or "DETAIL" in l
                   or "CONTEXT" in l or "HINT" in l]
            failures.append((fn, "\n".join(msg[:12]) or res.stdout))
            for l in msg[:6]:
                print("        " + l)

    print(f"\n{passed} passed, {failed} failed, {asserts} assertions, "
          f"{time.time()-t0:.1f}s")
    if failures:
        print("\n--- failures ---")
        for fn, msg in failures:
            print(f"\n{fn}\n{msg}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
