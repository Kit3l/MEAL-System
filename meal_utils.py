"""
MEAL System — Python Utilities & FastAPI Companion
====================================================
Handles:
  1.  FastAPI REST endpoints (alternative/companion to Node.js api.js)
  2.  KoboToolbox data pull & transformation pipeline
  3.  Automated Excel / PDF report generation
  4.  Data quality checks & validation
  5.  CLI tools for batch imports and maintenance

Setup:
    pip install fastapi uvicorn supabase python-dotenv httpx pandas
                openpyxl reportlab schedule pydantic python-multipart

.env file (same as api.js):
    SUPABASE_URL=https://your-project.supabase.co
    SUPABASE_SERVICE_KEY=your-service-role-key
    KOBO_API_TOKEN=your-kobotools-token
    KOBO_BASE_URL=https://kf.kobotoolbox.org
    API_SECRET=your-webhook-secret

Run server:    uvicorn meal_utils:app --reload --port 8000
Run CLI sync:  python meal_utils.py sync --asset-uid <uid> --project-id <id>
Run reports:   python meal_utils.py report --project-id <id> --format excel
"""

from __future__ import annotations

import os
import sys
import json
import asyncio
import argparse
import logging
from datetime import datetime, date, timedelta
from typing import Optional, List, Dict, Any

import httpx
import pandas as pd
from dotenv import load_dotenv
from pydantic import BaseModel, Field, validator
from supabase import create_client, Client

# ─── FastAPI (optional – comment out if using Node.js api.js only) ────────────
from fastapi import FastAPI, HTTPException, Depends, Header, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware

load_dotenv()
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("meal")

# ─── Supabase ─────────────────────────────────────────────────────────────────
supabase: Client = create_client(
    os.environ["SUPABASE_URL"],
    os.environ["SUPABASE_SERVICE_KEY"],
)

KOBO_BASE_URL  = os.getenv("KOBO_BASE_URL", "https://kf.kobotoolbox.org")
KOBO_API_TOKEN = os.getenv("KOBO_API_TOKEN", "")
API_SECRET     = os.getenv("API_SECRET", "changeme")

# ─────────────────────────────────────────────────────────────────────────────
# Pydantic models (request/response validation)
# ─────────────────────────────────────────────────────────────────────────────

class IndicatorDataIn(BaseModel):
    indicator_id:      str
    project_id:        str
    reporting_period:  str                    # e.g. "Q2-2025"
    period_start:      date
    period_end:        date
    target_value:      Optional[float] = None
    actual_value:      Optional[float] = None
    disaggregated_data: Dict[str, Any] = Field(default_factory=dict)
    notes:             Optional[str]   = None
    data_source_type:  str             = "manual"

    @validator("actual_value")
    def actual_non_negative(cls, v):
        if v is not None and v < 0:
            raise ValueError("actual_value must be non-negative")
        return v


class ProjectIn(BaseModel):
    title:          str
    code:           str
    organisation:   str
    start_date:     date
    end_date:       date
    thematic_area:  Optional[str] = None
    country:        str           = "Kenya"
    donor:          Optional[str] = None
    budget_usd:     Optional[float] = None
    status:         str           = "planning"

    @validator("end_date")
    def end_after_start(cls, v, values):
        if "start_date" in values and v < values["start_date"]:
            raise ValueError("end_date must be after start_date")
        return v


class KoboSyncRequest(BaseModel):
    asset_uid:   str
    project_id:  str
    indicator_id: Optional[str] = None


# ─────────────────────────────────────────────────────────────────────────────
# FastAPI app
# ─────────────────────────────────────────────────────────────────────────────

app = FastAPI(
    title="MEAL System API (Python)",
    description="Companion Python API for KoboToolbox sync, reports, and data quality.",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def verify_secret(x_api_secret: str = Header(None)):
    """Dependency: validate API secret header."""
    if x_api_secret != API_SECRET:
        raise HTTPException(status_code=401, detail="Invalid API secret")


# ─────────────────────────────────────────────────────────────────────────────
# HEALTH
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok", "service": "MEAL Python API", "time": datetime.utcnow().isoformat()}


# ─────────────────────────────────────────────────────────────────────────────
# PROJECTS
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/api/projects")
def list_projects(status: Optional[str] = None, country: Optional[str] = None):
    q = supabase.table("v_project_summary").select("*").order("created_at", desc=True)
    if status:  q = q.eq("status", status)
    if country: q = q.eq("country", country)
    result = q.execute()
    return {"success": True, "data": result.data}


@app.post("/api/projects", status_code=201)
def create_project(payload: ProjectIn):
    result = supabase.table("projects").insert(payload.dict()).execute()
    if not result.data:
        raise HTTPException(status_code=400, detail="Failed to create project")
    return {"success": True, "data": result.data[0]}


@app.get("/api/projects/{project_id}")
def get_project(project_id: str):
    result = (
        supabase.table("projects")
        .select("*, indicators(*), milestones(*), risks(*), learning_entries(*)")
        .eq("id", project_id)
        .single()
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Project not found")
    return {"success": True, "data": result.data}


# ─────────────────────────────────────────────────────────────────────────────
# INDICATOR DATA
# ─────────────────────────────────────────────────────────────────────────────

@app.post("/api/indicator-data", status_code=201)
def submit_indicator_data(payload: IndicatorDataIn):
    result = (
        supabase.table("indicator_data")
        .upsert(payload.dict(), on_conflict="indicator_id,reporting_period")
        .execute()
    )
    # Recalculate overall_actual
    rows = (
        supabase.table("indicator_data")
        .select("actual_value")
        .eq("indicator_id", payload.indicator_id)
        .execute()
    )
    cumulative = sum(r["actual_value"] or 0 for r in rows.data)
    supabase.table("indicators").update({"overall_actual": cumulative}).eq("id", payload.indicator_id).execute()

    return {"success": True, "data": result.data[0] if result.data else None}


# ─────────────────────────────────────────────────────────────────────────────
# DATA QUALITY CHECK
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/api/projects/{project_id}/data-quality")
def data_quality_check(project_id: str):
    """
    Runs a suite of data quality checks on a project and returns a report.
    Checks: completeness, outliers, duplicate periods, missing baselines.
    """
    indicators = (
        supabase.table("indicators")
        .select("*, indicator_data(*)")
        .eq("project_id", project_id)
        .execute()
    ).data or []

    issues = []
    score  = 100

    for ind in indicators:
        # Check: missing baseline
        if ind.get("baseline_value") is None:
            issues.append({
                "indicator": ind["name"],
                "type":      "missing_baseline",
                "severity":  "warning",
                "message":   "No baseline value set",
            })
            score -= 5

        # Check: no data entries
        data_rows = ind.get("indicator_data") or []
        if not data_rows:
            issues.append({
                "indicator": ind["name"],
                "type":      "no_data",
                "severity":  "error",
                "message":   "No reporting data entered",
            })
            score -= 10
            continue

        # Check: actual exceeds target by >200% (possible data error)
        for row in data_rows:
            if row.get("target_value") and row.get("actual_value"):
                ratio = row["actual_value"] / row["target_value"]
                if ratio > 2.0:
                    issues.append({
                        "indicator":  ind["name"],
                        "period":     row["reporting_period"],
                        "type":       "outlier",
                        "severity":   "warning",
                        "message":    f"Actual ({row['actual_value']}) is {ratio:.1f}× the target — verify data",
                    })
                    score -= 3

        # Check: duplicate periods
        periods = [r["reporting_period"] for r in data_rows]
        dupes   = [p for p in periods if periods.count(p) > 1]
        if dupes:
            issues.append({
                "indicator": ind["name"],
                "type":      "duplicate_period",
                "severity":  "error",
                "message":   f"Duplicate reporting period(s): {list(set(dupes))}",
            })
            score -= 8

    score = max(0, min(100, score))
    grade = "A" if score >= 90 else "B" if score >= 75 else "C" if score >= 60 else "D"

    return {
        "success": True,
        "data": {
            "project_id":      project_id,
            "quality_score":   score,
            "grade":           grade,
            "total_issues":    len(issues),
            "errors":   [i for i in issues if i["severity"] == "error"],
            "warnings": [i for i in issues if i["severity"] == "warning"],
            "checked_at":      datetime.utcnow().isoformat(),
        },
    }


# ─────────────────────────────────────────────────────────────────────────────
# KOBOTOOLS INTEGRATION
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/api/kobo/forms")
async def list_kobo_forms():
    """List all survey forms available in the linked KoboToolbox account."""
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get(
            f"{KOBO_BASE_URL}/api/v2/assets/?asset_type=survey",
            headers={"Authorization": f"Token {KOBO_API_TOKEN}"},
        )
    if r.status_code != 200:
        raise HTTPException(status_code=502, detail=f"KoboToolbox error: {r.text}")

    forms = [
        {
            "uid":         f["uid"],
            "name":        f["name"],
            "submissions": f.get("deployment__submission_count", 0),
            "deployed":    f.get("has_deployment", False),
            "modified":    f.get("date_modified"),
        }
        for f in r.json().get("results", [])
    ]
    return {"success": True, "data": forms}


@app.post("/api/kobo/sync")
async def kobo_sync(payload: KoboSyncRequest, background_tasks: BackgroundTasks,
                    _: None = Depends(verify_secret)):
    """
    Trigger a background sync from a KoboToolbox form.
    Returns immediately with a log_id to track progress.
    """
    log_result = supabase.table("kobo_sync_log").insert({
        "project_id":     payload.project_id,
        "kobo_asset_uid": payload.asset_uid,
        "sync_type":      "pull",
        "status":         "running",
    }).execute()
    log_id = log_result.data[0]["id"] if log_result.data else None

    background_tasks.add_task(
        run_kobo_sync,
        payload.asset_uid,
        payload.project_id,
        payload.indicator_id,
        log_id,
    )

    return {"success": True, "data": {"message": "Sync started", "log_id": log_id}}


@app.post("/api/kobo/webhook")
async def kobo_webhook(request_body: Dict[str, Any], x_kobo_secret: Optional[str] = Header(None)):
    """Receives real-time submissions from KoboToolbox REST Service webhooks."""
    if x_kobo_secret != API_SECRET:
        raise HTTPException(status_code=401, detail="Unauthorized")

    mapped = map_kobo_submission(request_body)
    if not mapped:
        return {"success": True, "data": {"message": "No mapping for this submission"}}

    supabase.table("indicator_data").upsert(
        mapped, on_conflict="indicator_id,reporting_period"
    ).execute()

    return {"success": True, "data": {"message": "Submission processed"}}


# ─────────────────────────────────────────────────────────────────────────────
# REPORT GENERATION
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/api/projects/{project_id}/report/excel")
def generate_excel_report(project_id: str):
    """
    Generate a comprehensive Excel progress report for a project.
    Returns file path (serve via static files or stream in production).
    """
    path = build_excel_report(project_id)
    return {"success": True, "data": {"file": path}}


@app.get("/api/projects/{project_id}/report/summary")
def project_summary_report(project_id: str):
    """
    Returns structured summary data for building a donor-ready PDF report.
    """
    project = (
        supabase.table("projects")
        .select("*, indicators(*), milestones(*), risks(*), learning_entries(*)")
        .eq("id", project_id)
        .single()
        .execute()
    ).data

    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    indicators = project.get("indicators") or []
    milestones  = project.get("milestones") or []
    risks       = project.get("risks") or []

    # Compute stats
    on_track   = sum(1 for i in indicators if (i.get("achievement_rate") or 0) >= 80)
    at_risk    = sum(1 for i in indicators if 50 <= (i.get("achievement_rate") or 0) < 80)
    off_track  = sum(1 for i in indicators if (i.get("achievement_rate") or 0) < 50)
    completed_ms = sum(1 for m in milestones if m.get("status") == "completed")
    high_risks   = sum(1 for r in risks if (r.get("risk_score") or 0) >= 6)

    avg_achievement = (
        sum(i.get("achievement_rate") or 0 for i in indicators) / len(indicators)
        if indicators else 0
    )

    return {
        "success": True,
        "data": {
            "project":         project,
            "summary_stats": {
                "avg_achievement_rate": round(avg_achievement, 1),
                "indicators_on_track":  on_track,
                "indicators_at_risk":   at_risk,
                "indicators_off_track": off_track,
                "milestones_completed": completed_ms,
                "milestones_total":     len(milestones),
                "high_risks":           high_risks,
            },
            "generated_at": datetime.utcnow().isoformat(),
        },
    }


# ─────────────────────────────────────────────────────────────────────────────
# INTERNAL HELPERS
# ─────────────────────────────────────────────────────────────────────────────

async def run_kobo_sync(asset_uid: str, project_id: str,
                        indicator_id: Optional[str], log_id: Optional[str]):
    """
    Background task: pull all submissions from KoboToolbox and upsert into DB.
    Handles pagination via KoboToolbox's next_page links.
    """
    inserted = updated = failed = 0
    errors: List[Dict] = []
    url = f"{KOBO_BASE_URL}/api/v2/assets/{asset_uid}/data/?format=json&limit=5000"

    try:
        async with httpx.AsyncClient(timeout=60) as client:
            while url:
                r = await client.get(
                    url,
                    headers={"Authorization": f"Token {KOBO_API_TOKEN}"},
                )
                if r.status_code != 200:
                    raise RuntimeError(f"KoboToolbox returned {r.status_code}: {r.text[:200]}")

                body  = r.json()
                subs  = body.get("results", [])
                url   = body.get("next")          # follow pagination

                log.info(f"[KoboSync] Processing {len(subs)} submissions…")

                for sub in subs:
                    try:
                        mapped = map_kobo_submission(sub, indicator_id, project_id)
                        if not mapped:
                            continue
                        supabase.table("indicator_data").upsert(
                            mapped, on_conflict="indicator_id,reporting_period"
                        ).execute()
                        inserted += 1
                    except Exception as sub_err:
                        failed += 1
                        errors.append({"id": sub.get("_id"), "error": str(sub_err)})

        status = "success" if failed == 0 else "partial"

    except Exception as e:
        log.error(f"[KoboSync] Fatal: {e}")
        failed += 1
        errors.append({"error": str(e)})
        status = "failed"

    finally:
        if log_id:
            supabase.table("kobo_sync_log").update({
                "records_inserted": inserted,
                "records_failed":   failed,
                "error_log":        errors,
                "completed_at":     datetime.utcnow().isoformat(),
                "status":           status,
            }).eq("id", log_id).execute()

        log.info(f"[KoboSync] Finished. Inserted={inserted} Failed={failed}")


def map_kobo_submission(sub: Dict, fallback_indicator_id: str = None,
                        fallback_project_id: str = None) -> Optional[Dict]:
    """
    Maps a raw KoboToolbox submission dict to an indicator_data row.
    ⚠️  Customise field names to match YOUR KoboToolbox form.
    """
    indicator_id = sub.get("monitoring/indicator_id") or fallback_indicator_id
    if not indicator_id:
        return None

    submission_time = sub.get("_submission_time", "")
    period = sub.get("monitoring/reporting_period") or submission_time[:7]
    if not period:
        return None

    period_start = datetime.strptime(period + "-01", "%Y-%m-%d").date()
    # Last day of month
    next_month   = period_start.replace(day=28) + timedelta(days=4)
    period_end   = next_month - timedelta(days=next_month.day)

    return {
        "indicator_id":      indicator_id,
        "project_id":        sub.get("monitoring/project_id") or fallback_project_id,
        "reporting_period":  period,
        "period_start":      period_start.isoformat(),
        "period_end":        period_end.isoformat(),
        "target_value":      _to_float(sub.get("monitoring/target_value")),
        "actual_value":      _to_float(sub.get("monitoring/actual_value")),
        "disaggregated_data": {
            "female": _to_int(sub.get("monitoring/female_count", 0)),
            "male":   _to_int(sub.get("monitoring/male_count", 0)),
        },
        "notes":             sub.get("monitoring/notes"),
        "data_source_type":  "kobo",
        "kobo_submission_id": str(sub.get("_id", "")),
    }


def build_excel_report(project_id: str) -> str:
    """
    Generates a multi-sheet Excel workbook for a project.
    Sheets: Summary, Indicators, Milestones, Risks, Raw Data
    Returns the file path.
    """
    project = (
        supabase.table("projects")
        .select("*, indicators(*, indicator_data(*)), milestones(*), risks(*)")
        .eq("id", project_id)
        .single()
        .execute()
    ).data

    if not project:
        raise ValueError(f"Project {project_id} not found")

    filename = f"/tmp/MEAL_Report_{project['code']}_{date.today().isoformat()}.xlsx"

    with pd.ExcelWriter(filename, engine="openpyxl") as writer:

        # ── Sheet 1: Summary ──────────────────────────────────────────────
        summary_data = {
            "Field": [
                "Project Title", "Project Code", "Status", "Organisation",
                "Donor", "Country", "Start Date", "End Date",
                "Total Beneficiaries", "Budget (USD)", "Report Date",
            ],
            "Value": [
                project.get("title"), project.get("code"), project.get("status"),
                project.get("organisation"), project.get("donor"), project.get("country"),
                project.get("start_date"), project.get("end_date"),
                project.get("beneficiaries_total"),
                f"${project.get('budget_usd', 0):,.2f}" if project.get("budget_usd") else "N/A",
                date.today().isoformat(),
            ],
        }
        pd.DataFrame(summary_data).to_excel(writer, sheet_name="Summary", index=False)

        # ── Sheet 2: Indicators ───────────────────────────────────────────
        indicators = project.get("indicators") or []
        if indicators:
            ind_rows = []
            for i in indicators:
                rate = i.get("achievement_rate")
                traffic = (
                    "On Track" if (rate or 0) >= 80
                    else "At Risk" if (rate or 0) >= 50
                    else "Off Track"
                ) if rate is not None else "No Data"
                ind_rows.append({
                    "Indicator":        i.get("name"),
                    "Level":            i.get("result_level"),
                    "Unit":             i.get("unit_of_measurement"),
                    "Baseline":         i.get("baseline_value"),
                    "Target":           i.get("overall_target"),
                    "Actual":           i.get("overall_actual"),
                    "Achievement (%)":  rate,
                    "Status":           traffic,
                    "Data Source":      i.get("data_source"),
                    "Frequency":        i.get("collection_frequency"),
                })
            pd.DataFrame(ind_rows).to_excel(writer, sheet_name="Indicators", index=False)

        # ── Sheet 3: Milestones ───────────────────────────────────────────
        milestones = project.get("milestones") or []
        if milestones:
            ms_rows = [{
                "Milestone":   m.get("title"),
                "Due Date":    m.get("due_date"),
                "Status":      m.get("status"),
                "Responsible": m.get("responsible"),
                "Completion %": m.get("completion_pct"),
                "Notes":       m.get("notes"),
            } for m in milestones]
            pd.DataFrame(ms_rows).to_excel(writer, sheet_name="Milestones", index=False)

        # ── Sheet 4: Risks ────────────────────────────────────────────────
        risks = project.get("risks") or []
        if risks:
            risk_rows = [{
                "Risk":         r.get("title"),
                "Type":         r.get("risk_type"),
                "Likelihood":   r.get("likelihood"),
                "Impact":       r.get("impact"),
                "Risk Score":   r.get("risk_score"),
                "Mitigation":   r.get("mitigation"),
                "Owner":        r.get("owner"),
                "Resolved":     r.get("is_resolved"),
            } for r in risks]
            pd.DataFrame(risk_rows).to_excel(writer, sheet_name="Risks", index=False)

    log.info(f"[Report] Excel saved → {filename}")
    return filename


def _to_float(v) -> Optional[float]:
    try:    return float(v)
    except: return None


def _to_int(v) -> int:
    try:    return int(v)
    except: return 0


# ─────────────────────────────────────────────────────────────────────────────
# CLI ENTRY POINT
# ─────────────────────────────────────────────────────────────────────────────

def cli_main():
    parser = argparse.ArgumentParser(description="MEAL System CLI")
    sub    = parser.add_subparsers(dest="command")

    # sync command
    sync_p = sub.add_parser("sync", help="Pull data from KoboToolbox")
    sync_p.add_argument("--asset-uid",    required=True, help="KoboToolbox form asset UID")
    sync_p.add_argument("--project-id",  required=True, help="Database project UUID")
    sync_p.add_argument("--indicator-id", default=None,  help="Map all submissions to this indicator")

    # report command
    rep_p = sub.add_parser("report", help="Generate a project report")
    rep_p.add_argument("--project-id", required=True, help="Database project UUID")
    rep_p.add_argument("--format",     default="excel", choices=["excel"], help="Output format")

    # quality command
    qual_p = sub.add_parser("quality", help="Run data quality check")
    qual_p.add_argument("--project-id", required=True)

    args = parser.parse_args()

    if args.command == "sync":
        print(f"Starting sync for KoboToolbox asset {args.asset_uid}…")
        asyncio.run(run_kobo_sync(args.asset_uid, args.project_id, args.indicator_id, None))
        print("Sync complete.")

    elif args.command == "report":
        print(f"Generating {args.format} report for project {args.project_id}…")
        path = build_excel_report(args.project_id)
        print(f"Report saved: {path}")

    elif args.command == "quality":
        # Inline quality check (reuse endpoint logic without HTTP)
        indicators = (
            supabase.table("indicators")
            .select("*, indicator_data(*)")
            .eq("project_id", args.project_id)
            .execute()
        ).data or []
        issues = []
        for ind in indicators:
            if ind.get("baseline_value") is None:
                issues.append(f"WARNING  [{ind['name']}] Missing baseline")
            if not ind.get("indicator_data"):
                issues.append(f"ERROR    [{ind['name']}] No data entries")
        if not issues:
            print("✓ No data quality issues found.")
        else:
            print(f"Found {len(issues)} issue(s):")
            for i in issues:
                print(f"  {i}")

    else:
        parser.print_help()


if __name__ == "__main__":
    if len(sys.argv) > 1:
        cli_main()
    else:
        import uvicorn
        uvicorn.run("meal_utils:app", host="0.0.0.0", port=8000, reload=True)
