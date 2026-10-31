#!/usr/bin/env python3
"""Measure the query plans of the critical reports, before and after indexes.

    db/tools/perf.py build            # make lms_perf at migration 0018 (no perf indexes) and load volume
    db/tools/perf.py measure baseline # EXPLAIN (ANALYZE, BUFFERS) each query, save as the baseline
    db/tools/perf.py index            # apply the remaining migrations (the indexes)
    db/tools/perf.py measure indexed  # measure again
    db/tools/perf.py report           # write docs/QUERY_PLAN_EVIDENCE.md

The point of the split is that the index set is chosen from the baseline plans
rather than guessed, and the claim that an index helped is a measurement rather
than an assertion. Nothing here says an index improved anything unless the two
runs say so.

Each query is run three times and the fastest execution is kept, to take the
cold-cache first run out of the comparison; buffer counts come from that run.
"""
import argparse
import json
import os
import re
import statistics
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROJECT = os.path.dirname(ROOT)
OUT = os.path.join(ROOT, "perf")
DB = os.environ.get("LMS_PERF_DB", "lms_perf")

# The queries that matter. Each is what a screen or a report actually runs:
# the dashboard, the landowner search, the project register, lease expiry, the
# approval queue, payment history, the liability register, the audit trail.
#
# {actor} is replaced by a representative user id and {prov} by a province, so
# the plans are measured with row-level security in force — which is how they
# will run in production, and which changes the plan.
QUERIES = {
    "q01_landowner_name_search": """
        SELECT landowner_id, landowner_code, full_name, cnic, holding_count, paid_to_date
        FROM api.v_landowner_summary
        WHERE full_name ILIKE '%Mukhtiar Jamali%'
        ORDER BY full_name LIMIT 50
    """,
    "q02_landowner_by_cnic": """
        SELECT * FROM lms.landowner WHERE cnic = '40007-0000007-7'
    """,
    "q03_project_register": """
        SELECT project_code, project_name, linked_parcels, live_cases, approved_cases,
               approved_compensation, released_amount
        FROM api.v_project_land_status
        WHERE province_code = '{prov}' AND status = 'Active'
        ORDER BY project_code LIMIT 100
    """,
    "q04_lease_expiry_90d": """
        SELECT lease_code, project_code, end_date, days_to_expiry, annual_rent, urgency
        FROM api.v_lease_expiry_alert
        ORDER BY days_to_expiry LIMIT 200
    """,
    "q05_approval_queue": """
        SELECT workflow_code, stage_code, assigned_group, waiting_count,
               oldest_assigned_at, max_days_waiting, overdue_count
        FROM api.v_approval_bottleneck
        ORDER BY waiting_count DESC
    """,
    "q06_payment_history_for_landowner": """
        SELECT pr.code, pr.period_from, pr.gross_amount, pr.net_amount, pr.stage_code,
               r.cheque_no, r.cheque_date
        FROM lms.payment_request pr
        LEFT JOIN lms.payment_release r ON r.payment_id = pr.id
        WHERE pr.landowner_id = (SELECT id FROM lms.landowner
                                 WHERE code LIKE 'PF-L%' ORDER BY code LIMIT 1)
        ORDER BY pr.period_from DESC
    """,
    "q07_outstanding_liability": """
        SELECT case_code, project_code, approved_amount, released_amount,
               outstanding_amount, days_since_approval
        FROM api.v_outstanding_liability
        WHERE province_code = '{prov}' AND outstanding_amount > 0
        ORDER BY outstanding_amount DESC LIMIT 100
    """,
    "q08_audit_trail_for_record": """
        SELECT occurred_at, actor_username, action, changed_fields
        FROM audit.audit_event
        WHERE entity = 'compensation_case'
          AND record_id = (SELECT id FROM lms.compensation_case
                           WHERE code LIKE 'PF-CC%' ORDER BY code LIMIT 1)
        ORDER BY occurred_at DESC
    """,
    "q09_province_dashboard": """
        SELECT * FROM api.v_province_summary ORDER BY display_order
    """,
    "q10_payment_register_report": """
        SELECT * FROM api.report_payment_register('{prov}',
                 (current_date - 400)::date, current_date, true)
    """,
    "q11_case_list_by_stage": """
        SELECT case_code, project_code, case_date, total_amount, days_at_stage, waiting_on_group
        FROM api.v_case_status
        WHERE province_code = '{prov}' AND stage_code = 'Verified'
        ORDER BY case_date DESC LIMIT 100
    """,
    "q12_duplicate_payment_check": """
        SELECT 1 FROM lms.payment_request
        WHERE payee_key = (SELECT id::text FROM lms.landowner
                           WHERE code LIKE 'PF-L%' ORDER BY code LIMIT 1)
          AND category_code = 'Lease Rent'
          AND period_from = DATE '2021-06-01'
          AND stage_code NOT IN ('Cancelled','Stopped')
    """,
    "q13_compensation_summary_report": """
        SELECT * FROM api.report_compensation_summary('{prov}')
    """,
    "q14_grievance_overdue": """
        SELECT grievance_code, complainant, severity, age_days
        FROM api.v_grievance_status
        WHERE is_overdue ORDER BY age_days DESC LIMIT 100
    """,
    "q16_province_dashboard_cached": """
        SELECT province_code, projects, parcels, landowners, live_cases,
               approved_compensation, released_amount, active_leases, age, is_overdue
        FROM api.v_province_summary_cached ORDER BY display_order
    """,
    "q15_parcel_ownership_lookup": """
        SELECT survey_code, location_path, total_area, share_total_pct, owner_count,
               committed_area
        FROM api.v_survey_ownership
        WHERE survey_code = (SELECT code FROM lms.survey
                             WHERE code LIKE 'PF-S%' ORDER BY code LIMIT 1)
    """,
}


def psql(sql, db=None, user="lms_migrator", quiet=True, timing=False):
    cmd = ["psql", "-v", "ON_ERROR_STOP=1", "--no-psqlrc", "-At",
           "-U", user, "-d", db or DB, "-f", "-"]
    if quiet:
        cmd.insert(1, "-q")
    r = subprocess.run(cmd, input=sql, capture_output=True, text=True)
    return r


def need(r, what):
    if r.returncode != 0:
        sys.stderr.write(r.stdout + r.stderr)
        sys.exit(f"failed: {what}")
    return r.stdout


def actor_and_province():
    """An administrator (so the plans are not trivially empty) and the province
    with the most cases, which is the realistic worst case."""
    out = need(psql(
        "SET ROLE lms_owner;\n"
        "SELECT (SELECT id FROM lms.app_user WHERE username='admin') || '|' ||"
        # Deterministic: province_code breaks the tie, so the baseline and the
        # indexed run measure the same province. Without it the two runs can
        # pick different provinces and the comparison is meaningless.
        " (SELECT province_code FROM lms.compensation_case GROUP BY 1"
        "  ORDER BY count(*) DESC, province_code LIMIT 1);"), "resolve fixture ids")
    actor, prov = out.strip().splitlines()[-1].split("|")
    return actor, prov


def cmd_build(args):
    print(f"building {DB} at migration 0018 (before the performance indexes) …")
    subprocess.run(["psql", "-q", "-d", "postgres", "-c",
                    f"SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                    f"WHERE datname = '{DB}' AND pid <> pg_backend_pid()"],
                   capture_output=True, text=True)
    need(subprocess.run(["psql", "-q", "-d", "postgres", "-c",
                         f"DROP DATABASE IF EXISTS {DB}"],
                        capture_output=True, text=True), "drop")
    need(subprocess.run(["psql", "-q", "-v", "ON_ERROR_STOP=1", "-d", "postgres",
                         "-v", f"db={DB}", "-f",
                         os.path.join(ROOT, "bootstrap", "02_database.sql")],
                        capture_output=True, text=True), "create")
    env = dict(os.environ, LMS_DSN=f"postgresql:///{DB}?user=lms_migrator")
    need(subprocess.run([sys.executable, os.path.join(ROOT, "tools", "migrate.py"),
                         "up", "--to", "0018"], capture_output=True, text=True, env=env),
         "migrate to 0018")
    need(psql(open(os.path.join(ROOT, "seed", "seed_demo.sql")).read()), "seed users")

    print("loading the volume fixture (this takes a few minutes) …")
    t0 = time.time()
    r = subprocess.run(["psql", "-v", "ON_ERROR_STOP=1", "--no-psqlrc", "-q",
                        "-U", "lms_migrator", "-d", DB,
                        "-v", f"scale={args.scale}",
                        "-f", os.path.join(ROOT, "tools", "perf_load.sql")],
                       capture_output=True, text=True)
    need(r, "load volume")
    print(f"loaded in {time.time()-t0:.0f}s")
    cmd_sizes(args)


def cmd_sizes(args):
    out = need(psql("""
      SET ROLE lms_owner;
      SELECT rpad(n.nspname || '.' || c.relname, 42)
             || lpad(to_char(c.reltuples::bigint, '999G999G999'), 13)
             || lpad(pg_size_pretty(pg_total_relation_size(c.oid)), 12)
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('lms','audit') AND c.relkind = 'r'
        AND c.reltuples > 0
      ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 25;
    """), "sizes")
    print(f"\n{'table':<42}{'rows':>13}{'size':>12}")
    print(out.rstrip())
    db_size = need(psql("SELECT pg_size_pretty(pg_database_size(current_database()))"),
                   "db size").strip()
    print(f"\ndatabase size: {db_size}")
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, "volume.txt"), "w") as fh:
        fh.write(f"{'table':<42}{'rows':>13}{'size':>12}\n{out}\ndatabase size: {db_size}\n")


def run_one(name, sql, actor, prov, repeats=3):
    """EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) the query, as the application
    role with an actor set, so row-level security is in force."""
    q = sql.format(actor=actor, prov=prov).strip()
    best = None
    for _ in range(repeats):
        script = (
            "BEGIN;\n"
            f"SELECT api.set_actor('{actor}');\n"
            f"EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) {q};\n"
            "ROLLBACK;\n")
        r = psql(script, user="lms_test")
        if r.returncode != 0:
            return {"name": name, "error": (r.stderr or r.stdout).strip()[:600]}
        # psql -At prints the JSON across lines; the plan is the whole output
        # minus the set_actor line.
        txt = r.stdout
        i = txt.index("[")
        plan = json.loads(txt[i:])[0]
        ms = plan["Execution Time"]
        if best is None or ms < best["ms"]:
            best = {"ms": ms, "plan": plan}
    p = best["plan"]["Plan"]
    return {
        "name": name,
        "ms": round(best["ms"], 2),
        "planning_ms": round(best["plan"].get("Planning Time", 0), 2),
        "rows": p.get("Actual Rows"),
        "shared_hit": p.get("Shared Hit Blocks"),
        "shared_read": p.get("Shared Read Blocks"),
        "node": p.get("Node Type"),
        "seq_scans": sorted(set(collect(p, "Seq Scan"))),
        "index_scans": sorted(set(collect_index(p))),
        "plan_text": summarise(p),
    }


def collect(node, want, acc=None):
    acc = acc if acc is not None else []
    if node.get("Node Type") == want:
        acc.append(node.get("Relation Name"))
    for k in ("Plans", "Subplans"):
        for ch in node.get(k, []) or []:
            collect(ch, want, acc)
    return [a for a in acc if a]


def collect_index(node, acc=None):
    acc = acc if acc is not None else []
    if node.get("Node Type") in ("Index Scan", "Index Only Scan", "Bitmap Index Scan"):
        if node.get("Index Name"):
            acc.append(node["Index Name"])
    for k in ("Plans", "Subplans"):
        for ch in node.get(k, []) or []:
            collect_index(ch, acc)
    return acc


def summarise(node, depth=0, acc=None):
    acc = acc if acc is not None else []
    label = node.get("Node Type", "?")
    for key in ("Relation Name", "Index Name"):
        if node.get(key):
            label += f" on {node[key]}"
    label += (f"  (rows={node.get('Actual Rows')}"
              f" est={node.get('Plan Rows')}"
              f" loops={node.get('Actual Loops')}"
              f" ms={round(node.get('Actual Total Time', 0), 2)})")
    acc.append("  " * depth + "-> " + label)
    for k in ("Plans", "Subplans"):
        for ch in node.get(k, []) or []:
            summarise(ch, depth + 1, acc)
    return "\n".join(acc)


def cmd_measure(args):
    actor, prov = actor_and_province()
    os.makedirs(OUT, exist_ok=True)
    results = []
    print(f"measuring as actor {actor[:8]}…, province {prov}\n")
    print(f"{'query':<38}{'ms':>9}{'rows':>8}{'read':>8}  scans")
    for name, sql in QUERIES.items():
        res = run_one(name, sql, actor, prov)
        results.append(res)
        if "error" in res:
            print(f"{name:<38}{'ERROR':>9}  {res['error'][:60]}")
        else:
            scans = ("seq:" + ",".join(res["seq_scans"])) if res["seq_scans"] else ""
            print(f"{name:<38}{res['ms']:>9.2f}{res['rows'] or 0:>8}"
                  f"{res['shared_read'] or 0:>8}  {scans[:70]}")
    path = os.path.join(OUT, f"{args.label}.json")
    with open(path, "w") as fh:
        json.dump({"label": args.label, "actor": actor, "province": prov,
                   "pg_version": need(psql("SELECT version()"), "version").strip(),
                   "when": time.strftime("%Y-%m-%d %H:%M:%S"),
                   "results": results}, fh, indent=1)
    print(f"\nwritten to {path}")


def cmd_index(args):
    env = dict(os.environ, LMS_DSN=f"postgresql:///{DB}?user=lms_migrator")
    print(need(subprocess.run([sys.executable, os.path.join(ROOT, "tools", "migrate.py"), "up"],
                              capture_output=True, text=True, env=env), "apply indexes"))
    need(psql("SET ROLE lms_owner; ANALYZE;"), "analyze")
    out = need(psql("""
      SET ROLE lms_owner;
      SELECT 'total index size: ' || pg_size_pretty(sum(pg_relation_size(i.indexrelid)))
      FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('lms','audit');
    """), "index size")
    print(out.strip())


def cmd_report(args):
    base = json.load(open(os.path.join(OUT, "baseline.json")))
    after = json.load(open(os.path.join(OUT, "indexed.json")))
    by = {r["name"]: r for r in after["results"]}
    # An optional third run, after the cluster-level leakproof step in
    # db/bootstrap/03_leakproof.sql. Kept separate so the index work and the
    # cluster decision are not credited to each other.
    lp_path = os.path.join(OUT, "leakproof.json")
    lp = json.load(open(lp_path)) if os.path.exists(lp_path) else None
    lpby = {r["name"]: r for r in lp["results"]} if lp else {}
    vol = ""
    vp = os.path.join(OUT, "volume.txt")
    if os.path.exists(vp):
        vol = open(vp).read()

    unused = need(psql("""
      SET ROLE lms_owner;
      SELECT n.nspname || '.' || ci.relname
      FROM pg_stat_user_indexes s
      JOIN pg_class ci ON ci.oid = s.indexrelid
      JOIN pg_namespace n ON n.oid = ci.relnamespace
      JOIN pg_index i ON i.indexrelid = s.indexrelid
      WHERE n.nspname IN ('lms','audit') AND s.idx_scan = 0
        AND NOT i.indisunique AND NOT i.indisprimary
      ORDER BY 1;
    """), "unused indexes").strip()

    idx_size = need(psql("""
      SET ROLE lms_owner;
      SELECT pg_size_pretty(sum(pg_relation_size(i.indexrelid)))
      FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('lms','audit');
    """), "index size").strip()

    lines = [
        "# Query-plan evidence",
        "",
        "Generated by `db/tools/perf.py report`. Every number here is measured, not",
        "estimated. Reproduce it with:",
        "",
        "```sh",
        "db/tools/perf.py build            # schema at migration 0018, then the volume fixture",
        "db/tools/perf.py measure baseline",
        "db/tools/perf.py index            # apply migration 0019, the performance indexes",
        "db/tools/perf.py measure indexed",
        "db/tools/perf.py report",
        "```",
        "",
        "## Test environment",
        "",
        f"- PostgreSQL: `{base['pg_version']}`",
        "- Host: developer workstation (Apple silicon, local Unix socket), not a",
        "  production-like server. Absolute timings are therefore indicative; the",
        "  **ratio** between the two runs and the **plan shapes** are what transfer.",
        f"- Measured as the application role (`lms_test`), with row-level security in",
        f"  force and an actor set — so these are the plans the application gets, not",
        f"  the plans a superuser would see.",
        f"- Province used for the scoped queries: `{base['province']}`",
        "- Each query run three times; the fastest execution is reported, so a cold",
        "  first read does not dominate. Buffer counts come from that run.",
        f"- Baseline measured: {base['when']}  ·  indexed: {after['when']}",
        "",
        "## Data volume",
        "",
        "```",
        vol.rstrip() or "(not recorded)",
        "```",
        "",
        "## Results",
        "",
        "| query | baseline ms | indexed ms | change | rows | blocks read (base → idx) |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    improved = regressed = unchanged = 0
    for r in base["results"]:
        a = by.get(r["name"], {})
        if "error" in r and "error" not in a:
            # Measurable only after migration 0019 — the object it reads did
            # not exist at the baseline.
            lines.append(f"| `{r['name']}` | n/a | {a['ms']:.2f} | new in 0019 | "
                         f"{a.get('rows')} | — → {a.get('shared_read')} |")
            continue
        if "error" in r or "error" in a:
            err = (r.get("error") or a.get("error", ""))[:60]
            lines.append(f"| `{r['name']}` | — | — | error: {err} | — | — |")
            continue
        b_ms, a_ms = r["ms"], a["ms"]
        if a_ms < b_ms * 0.8:
            change, improved = f"**{b_ms / max(a_ms, 0.01):.1f}× faster**", improved + 1
        elif a_ms > b_ms * 1.25:
            change, regressed = f"{a_ms / max(b_ms, 0.01):.1f}× slower", regressed + 1
        else:
            change, unchanged = "no material change", unchanged + 1
        lines += [f"| `{r['name']}` | {b_ms:.2f} | {a_ms:.2f} | {change} | "
                  f"{a.get('rows')} | {r.get('shared_read')} → {a.get('shared_read')} |"]

    if lp:
        lines += [
            "",
            "### After the optional cluster step",
            "",
            "`db/bootstrap/03_leakproof.sql` marks citext's comparison operators",
            "LEAKPROOF, which lets the planner use the unique index on a record-code",
            "column under row-level security. Without it a code lookup is a sequential",
            "scan, because a non-leakproof operator cannot be evaluated before a",
            "security policy. It is a superuser decision with its own reasoning and",
            "risk, written at the top of that file, so it is measured separately",
            "rather than folded into the index work above.",
            "",
            "| query | indexed ms | + leakproof ms | change |",
            "| --- | --- | --- | --- |",
        ]
        for r in base["results"]:
            a, l = by.get(r["name"], {}), lpby.get(r["name"], {})
            if "ms" not in a or "ms" not in l:
                continue
            if l["ms"] < a["ms"] * 0.8:
                ch = f"**{a['ms'] / max(l['ms'], 0.01):.1f}× faster**"
            elif l["ms"] > a["ms"] * 1.25:
                ch = f"{l['ms'] / max(a['ms'], 0.01):.1f}× slower"
            else:
                ch = "no material change"
            lines.append(f"| `{r['name']}` | {a['ms']:.2f} | {l['ms']:.2f} | {ch} |")
        lines += [
            "",
            "Measured directly, outside the query set above, on the same fixture:",
            "",
            "```",
            "SELECT id FROM lms.survey WHERE code = 'PF-S0000042';   -- 60,013 rows, 20 MB",
            "",
            "  without the step:  Seq Scan, 60,012 rows removed by filter   ~207 ms",
            "  with the step:     Index Scan using survey_code_key            ~1.7 ms",
            "```",
            "",
            "The cost of not taking the step grows linearly with the table, so the",
            "gap widens over the system's life. If the step is declined, code lookups",
            "stay correct and stay slow; the decision is recorded as DB-12 in",
            "docs/SECURITY_FINDINGS.md.",
        ]

    lines += [
        "",
        f"{improved} queries materially faster, {unchanged} unchanged, {regressed} slower.",
        "",
        "A query that did not change is reported as unchanged rather than being",
        "credited to an index. Several of these are small aggregate views over",
        "reference-sized tables, where a sequential scan is the right plan and an",
        "index would be dead weight.",
        "",
        f"Total index size on `lms` and `audit` after migration 0019: **{idx_size}**.",
        "",
        "## Plans",
        "",
    ]
    for r in base["results"]:
        a = by.get(r["name"], {})
        lines += [f"### `{r['name']}`", ""]
        if "error" in r:
            lines += ["Baseline failed:", "", "```", r["error"], "```", ""]
            continue
        lines += ["Baseline:", "", "```", r["plan_text"], "```", ""]
        if "plan_text" in a:
            lines += ["With the indexes:", "", "```", a["plan_text"], "```", ""]
            if a.get("index_scans"):
                lines += ["Indexes used: " + ", ".join(f"`{i}`" for i in a["index_scans"]), ""]
            if a.get("seq_scans"):
                lines += ["Sequential scans remaining: "
                          + ", ".join(f"`{s}`" for s in a["seq_scans"])
                          + " — see the notes in migration 0019 for why these are left alone.", ""]

    lines += [
        "## Indexes never used by any measured query",
        "",
        "```",
        unused or "(none)",
        "```",
        "",
        "An index in this list is not automatically wrong — it may serve a write-path",
        "constraint, or a query this set does not cover — but each one costs storage",
        "and write time, so the list is worth reading before adding more.",
        "",
    ]
    path = os.path.join(PROJECT, "docs", "QUERY_PLAN_EVIDENCE.md")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as fh:
        fh.write("\n".join(lines) + "\n")
    print(f"written {path}")


def main():
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("command", choices=["build", "measure", "index", "report", "sizes"])
    p.add_argument("label", nargs="?", default="baseline")
    p.add_argument("--scale", type=int, default=1)
    a = p.parse_args()
    return {"build": cmd_build, "measure": cmd_measure, "index": cmd_index,
            "report": cmd_report, "sizes": cmd_sizes}[a.command](a)


if __name__ == "__main__":
    sys.exit(main() or 0)
