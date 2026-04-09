/**
 * MEAL System — Node.js / Express API
 * ====================================
 * REST API backend connecting the frontend form to Supabase PostgreSQL.
 * Also handles KoboToolbox webhook + scheduled sync.
 *
 * Setup:
 *   npm init -y
 *   npm install express cors dotenv @supabase/supabase-js axios node-cronapp.use(helmet({
  contentSecurityPolicy: false,
}));
 *
 * .env file needed:
 *   PORT=3000
 *   SUPABASE_URL=https://your-project.supabase.co
 *   SUPABASE_SERVICE_KEY=your-service-role-key
 *   KOBO_API_TOKEN=your-kobotools-api-token
 *   KOBO_BASE_URL=https://kf.kobotoolbox.org
 *   API_SECRET=your-webhook-secret
 *
 * Run:  node api.js
 */

require("dotenv").config();
const express    = require("express");
const cors       = require("cors");
const helmet     = require("helmet");
const cron       = require("node-cron");
const rateLimit  = require("express-rate-limit");
const { createClient } = require("@supabase/supabase-js");
const axios      = require("axios");

// ─── Supabase client ──────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ─── App setup ────────────────────────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3000;

app.use(helmet());
app.use(cors({ origin: process.env.ALLOWED_ORIGINS?.split(",") || "*" }));
app.use(express.json({ limit: "2mb" }));

// Rate limit: 100 requests per 15 minutes per IP
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }));

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Standard JSON response */
const ok  = (res, data, status = 200) => res.status(status).json({ success: true, data });
const err = (res, msg, status = 500) => res.status(status).json({ success: false, error: msg });

/** Supabase error handler */
function dbErr(res, error, fallback = "Database error") {
  console.error("[DB]", error);
  return err(res, error?.message || fallback, 400);
}

// ─────────────────────────────────────────────────────────────────────────────
// PROJECTS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/projects
 * List all projects with summary counts.
 * Query params: status, thematic_area, country, search
 */
app.get("/api/projects", async (req, res) => {
  try {
    let query = supabase
      .from("v_project_summary")
      .select("*")
      .order("created_at", { ascending: false });

    if (req.query.status)        query = query.eq("status", req.query.status);
    if (req.query.thematic_area) query = query.eq("thematic_area", req.query.thematic_area);
    if (req.query.country)       query = query.eq("country", req.query.country);
    if (req.query.search) {
      query = query.or(
        `title.ilike.%${req.query.search}%,code.ilike.%${req.query.search}%`
      );
    }

    const { data, error } = await query;
    if (error) return dbErr(res, error);
    ok(res, data);
  } catch (e) {
    err(res, e.message);
  }
});

/**
 * POST /api/projects
 * Create a new project (full registration from the HTML form).
 * Body: project object + indicators[] + milestones[] + risks[]
 */
app.post("/api/projects", async (req, res) => {
  const { indicators = [], milestones = [], risks = [], ...projectData } = req.body;

  // Validate required fields
  const required = ["title", "code", "organisation", "start_date", "end_date"];
  const missing  = required.filter(f => !projectData[f]);
  if (missing.length) return err(res, `Missing required fields: ${missing.join(", ")}`, 422);

  try {
    // 1. Insert project
    const { data: project, error: pErr } = await supabase
      .from("projects")
      .insert(projectData)
      .select()
      .single();

    if (pErr) return dbErr(res, pErr);

    const projectId = project.id;
    const results   = { project, indicators: [], milestones: [], risks: [] };

    // 2. Insert indicators (in bulk)
    if (indicators.length > 0) {
      const indRows = indicators.map((ind, i) => ({
        ...ind,
        project_id: projectId,
        sort_order: i,
      }));
      const { data: indData, error: indErr } = await supabase
        .from("indicators")
        .insert(indRows)
        .select();
      if (indErr) console.error("[indicators insert]", indErr.message);
      else results.indicators = indData;
    }

    // 3. Insert milestones
    if (milestones.length > 0) {
      const msRows = milestones.map((m, i) => ({
        ...m,
        project_id: projectId,
        sort_order: i,
      }));
      const { data: msData, error: msErr } = await supabase
        .from("milestones")
        .insert(msRows)
        .select();
      if (msErr) console.error("[milestones insert]", msErr.message);
      else results.milestones = msData;
    }

    // 4. Insert risks
    if (risks.length > 0) {
      const riskRows = risks.map(r => ({ ...r, project_id: projectId }));
      const { data: riskData, error: riskErr } = await supabase
        .from("risks")
        .insert(riskRows)
        .select();
      if (riskErr) console.error("[risks insert]", riskErr.message);
      else results.risks = riskData;
    }

    ok(res, results, 201);
  } catch (e) {
    err(res, e.message);
  }
});

/**
 * GET /api/projects/:id
 * Get a single project with all related data.
 */
app.get("/api/projects/:id", async (req, res) => {
  try {
    const { data: project, error } = await supabase
      .from("projects")
      .select(`
        *,
        indicators(*),
        milestones(*),
        risks(*),
        learning_entries(*)
      `)
      .eq("id", req.params.id)
      .single();

    if (error) return dbErr(res, error);
    if (!project) return err(res, "Project not found", 404);
    ok(res, project);
  } catch (e) {
    err(res, e.message);
  }
});

/**
 * PATCH /api/projects/:id
 * Update project fields (partial update).
 */
app.patch("/api/projects/:id", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("projects")
      .update(req.body)
      .eq("id", req.params.id)
      .select()
      .single();
    if (error) return dbErr(res, error);
    ok(res, data);
  } catch (e) {
    err(res, e.message);
  }
});

/**
 * DELETE /api/projects/:id
 * Soft-delete by setting status to 'closed' (preferred over hard delete).
 */
app.delete("/api/projects/:id", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("projects")
      .update({ status: "closed" })
      .eq("id", req.params.id)
      .select()
      .single();
    if (error) return dbErr(res, error);
    ok(res, { message: "Project closed", project: data });
  } catch (e) {
    err(res, e.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// INDICATORS & DATA ENTRY
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/indicators/:id/data
 * Submit indicator data for a reporting period.
 */
app.post("/api/indicators/:id/data", async (req, res) => {
  const { id } = req.params;
  const payload = { ...req.body, indicator_id: id };

  // Fetch the indicator's project_id
  const { data: ind, error: indErr } = await supabase
    .from("indicators")
    .select("project_id, overall_target")
    .eq("id", id)
    .single();
  if (indErr) return dbErr(res, indErr);

  payload.project_id = ind.project_id;

  try {
    // Upsert: one record per indicator per period
    const { data, error } = await supabase
      .from("indicator_data")
      .upsert(payload, { onConflict: "indicator_id,reporting_period" })
      .select()
      .single();
    if (error) return dbErr(res, error);

    // Recalculate cumulative overall_actual on indicators table
    const { data: rows } = await supabase
      .from("indicator_data")
      .select("actual_value")
      .eq("indicator_id", id);

    const cumulative = rows?.reduce((s, r) => s + (r.actual_value || 0), 0) || 0;
    await supabase
      .from("indicators")
      .update({ overall_actual: cumulative })
      .eq("id", id);

    ok(res, data, 201);
  } catch (e) {
    err(res, e.message);
  }
});

/**
 * GET /api/projects/:id/indicators/progress
 * Returns indicator progress view for a project.
 */
app.get("/api/projects/:id/indicators/progress", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("v_indicator_progress")
      .select("*")
      .eq("project_id", req.params.id);
    if (error) return dbErr(res, error);
    ok(res, data);
  } catch (e) {
    err(res, e.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DASHBOARD & ANALYTICS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/dashboard
 * Returns portfolio-level stats for the main dashboard.
 */
app.get("/api/dashboard", async (req, res) => {
  try {
    const [portfolio, overdue, highRisks] = await Promise.all([
      supabase.from("v_portfolio_dashboard").select("*"),
      supabase.from("v_overdue_milestones").select("*").limit(10),
      supabase
        .from("risks")
        .select("*, projects(title,code)")
        .gte("risk_score", 6)
        .eq("is_resolved", false)
        .order("risk_score", { ascending: false })
        .limit(10),
    ]);

    ok(res, {
      portfolio:  portfolio.data  || [],
      overdue:    overdue.data    || [],
      high_risks: highRisks.data  || [],
    });
  } catch (e) {
    err(res, e.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// KOBOTOOLS INTEGRATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/kobo/webhook
 * Receives KoboToolbox webhook submissions in real time.
 * Configure this URL in KoboToolbox project → Settings → REST Services.
 *
 * KoboToolbox POST body structure:
 *   { "_id": 123, "formhub/uuid": "...", "group/question": "value", ... }
 */
app.post("/api/kobo/webhook", async (req, res) => {
  // Verify secret header
  const secret = req.headers["x-kobo-secret"] || req.query.secret;
  if (secret !== process.env.API_SECRET) {
    return err(res, "Unauthorized", 401);
  }

  const submission = req.body;
  console.log(`[KoboWebhook] Received submission ID: ${submission["_id"]}`);

  try {
    const mapped = mapKoboToIndicatorData(submission);
    if (!mapped) {
      return ok(res, { message: "Submission received but no mapping matched" });
    }

    const { data, error } = await supabase
      .from("indicator_data")
      .upsert(mapped, { onConflict: "indicator_id,reporting_period" })
      .select()
      .single();

    if (error) return dbErr(res, error);
    ok(res, { message: "Submission processed", record: data });
  } catch (e) {
    err(res, e.message);
  }
});

app.post("/api/kobo/sync", async (req, res) => {
  const { asset_uid, project_id, indicator_id } = req.body;
  if (!asset_uid) return err(res, "asset_uid is required", 422);
  req.params = { assetUid: asset_uid };
  req.body.project_id = project_id;

  const { data: syncLog } = await supabase
    .from("kobo_sync_log")
    .insert({
      project_id,
      kobo_asset_uid: asset_uid,
      sync_type: "pull",
      status: "running",
    })
    .select()
    .single();

  const logId = syncLog?.id;
  res.status(202).json({
    success: true,
    data: { message: "Sync started", log_id: logId },
  });

  runKoboSync(asset_uid, project_id, indicator_id, logId).catch(console.error);
});

app.post("/api/kobo/sync/:assetUid", async (req, res) => {
  const { assetUid } = req.params;
  const { project_id, indicator_id } = req.body;

  // Create sync log entry
  const { data: syncLog } = await supabase
    .from("kobo_sync_log")
    .insert({
      project_id,
      kobo_asset_uid: assetUid,
      sync_type: "pull",
      status: "running",
    })
    .select()
    .single();

  const logId = syncLog?.id;

  // Run sync asynchronously so we can return 202 immediately
  res.status(202).json({
    success: true,
    data: { message: "Sync started", log_id: logId },
  });

  // Perform sync in background
  runKoboSync(assetUid, project_id, indicator_id, logId).catch(console.error);
});

/**
 * GET /api/kobo/forms
 * List all KoboToolbox forms available to this account.
 */
app.get("/api/kobo/forms", async (req, res) => {
  try {
    const response = await axios.get(
      `${process.env.KOBO_BASE_URL}/api/v2/assets/?asset_type=survey`,
      {
        headers: { Authorization: `Token ${process.env.KOBO_API_TOKEN}` },
        timeout: 10000,
      }
    );
    const forms = response.data.results.map(f => ({
      uid:         f.uid,
      name:        f.name,
      submissions: f.deployment__submission_count,
      deployed:    f.has_deployment,
      modified:    f.date_modified,
    }));
    ok(res, forms);
  } catch (e) {
    err(res, `KoboToolbox API error: ${e.message}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// KOBO SYNC LOGIC (internal)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetches all submissions from a KoboToolbox form and upserts into indicator_data.
 * Handles pagination (KoboToolbox returns max 30,000 per request).
 */
async function runKoboSync(assetUid, projectId, indicatorId, logId) {
  let inserted = 0, updated = 0, failed = 0;
  const errors = [];

  try {
    // Fetch submissions from KoboToolbox
    const url = `${process.env.KOBO_BASE_URL}/api/v2/assets/${assetUid}/data/?format=json&limit=5000`;
    const response = await axios.get(url, {
      headers: { Authorization: `Token ${process.env.KOBO_API_TOKEN}` },
      timeout: 30000,
    });

    const submissions = response.data.results || [];
    console.log(`[KoboSync] Fetched ${submissions.length} submissions for ${assetUid}`);

    for (const sub of submissions) {
      try {
        const mapped = mapKoboToIndicatorData(sub, indicatorId, projectId);
        if (!mapped) continue;

        const { error } = await supabase
          .from("indicator_data")
          .upsert(mapped, { onConflict: "indicator_id,reporting_period" });

        if (error) {
          failed++;
          errors.push({ id: sub["_id"], error: error.message });
        } else {
          inserted++;
        }
      } catch (subErr) {
        failed++;
        errors.push({ id: sub["_id"], error: subErr.message });
      }
    }

    // Update sync log
    await supabase.from("kobo_sync_log").update({
      records_fetched:  submissions.length,
      records_inserted: inserted,
      records_failed:   failed,
      error_log:        errors,
      completed_at:     new Date().toISOString(),
      status:           failed > 0 ? "partial" : "success",
    }).eq("id", logId);

    console.log(`[KoboSync] Done. Inserted: ${inserted}, Failed: ${failed}`);
  } catch (e) {
    console.error("[KoboSync] Fatal error:", e.message);
    await supabase.from("kobo_sync_log").update({
      status: "failed",
      error_log: [{ error: e.message }],
      completed_at: new Date().toISOString(),
    }).eq("id", logId);
  }
}

/**
 * Maps a raw KoboToolbox submission to an indicator_data row.
 *
 * ⚠️  CUSTOMISE THIS FUNCTION for your form structure.
 * KoboToolbox field names follow the pattern "group_name/question_name".
 *
 * Example KoboToolbox fields (edit to match your form):
 *   indicator_id     → "monitoring/indicator_id"
 *   reporting_period → "monitoring/reporting_period"
 *   target_value     → "monitoring/target_value"
 *   actual_value     → "monitoring/actual_value"
 *   disaggregated_female → "monitoring/female_count"
 *   disaggregated_male   → "monitoring/male_count"
 */
function mapKoboToIndicatorData(submission, fallbackIndicatorId = null, fallbackProjectId = null) {
  const indicatorId = submission["monitoring/indicator_id"] || fallbackIndicatorId;
  if (!indicatorId) return null;

  const period     = submission["monitoring/reporting_period"] || submission["_submission_time"]?.slice(0, 7);
  const periodDate = period ? new Date(period + "-01") : new Date();

  return {
    indicator_id:      indicatorId,
    project_id:        submission["monitoring/project_id"] || fallbackProjectId,
    reporting_period:  period,
    period_start:      periodDate.toISOString().slice(0, 10),
    period_end:        new Date(periodDate.getFullYear(), periodDate.getMonth() + 1, 0)
                         .toISOString().slice(0, 10),
    target_value:      parseFloat(submission["monitoring/target_value"]) || null,
    actual_value:      parseFloat(submission["monitoring/actual_value"]) || null,
    disaggregated_data: {
      female: parseInt(submission["monitoring/female_count"]) || 0,
      male:   parseInt(submission["monitoring/male_count"])   || 0,
    },
    notes:             submission["monitoring/notes"] || null,
    data_source_type:  "kobo",
    kobo_submission_id: String(submission["_id"]),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SCHEDULED JOBS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Daily at 02:00 — sync all active KoboToolbox forms for active projects.
 * Reads projects that have a linked kobo_asset_uid in their metadata.
 */
cron.schedule("0 2 * * *", async () => {
  console.log("[Cron] Daily KoboToolbox sync starting…");

  const { data: projects } = await supabase
    .from("projects")
    .select("id, code, kobo_asset_uid:description")  // store uid in a dedicated column in prod
    .eq("status", "active");

  if (!projects?.length) {
    console.log("[Cron] No active projects to sync.");
    return;
  }

  for (const p of projects) {
    if (!p.kobo_asset_uid) continue;
    console.log(`[Cron] Syncing project ${p.code}…`);
    const { data: log } = await supabase
      .from("kobo_sync_log")
      .insert({ project_id: p.id, kobo_asset_uid: p.kobo_asset_uid, sync_type: "scheduled", status: "running" })
      .select().single();
    await runKoboSync(p.kobo_asset_uid, p.id, null, log?.id);
  }
});

/**
 * Every Monday at 08:00 — flag overdue milestones and log them.
 */
cron.schedule("0 8 * * 1", async () => {
  console.log("[Cron] Checking overdue milestones…");
  const { data, error } = await supabase
    .from("v_overdue_milestones")
    .select("id, project_title, title, days_overdue");
  if (error) { console.error(error.message); return; }
  console.log(`[Cron] ${data?.length || 0} overdue milestone(s) found.`);
  // Hook your email/SMS notification service here
});

// ─────────────────────────────────────────────────────────────────────────────
// HEALTH CHECK & START
// ─────────────────────────────────────────────────────────────────────────────

const path = require("path");
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/health", (req, res) => {
  res.json({
    status:  "ok",
    service: "MEAL API",
    version: "1.0.0",
    time:    new Date().toISOString(),
  });
});

// 404 handler
app.use((req, res) => err(res, `Route ${req.method} ${req.path} not found`, 404));

// Global error handler
app.use((error, req, res, next) => {
  console.error("[Unhandled]", error);
  err(res, "Internal server error", 500);
});

app.listen(PORT, () => {
  console.log(`✓ MEAL API running on http://localhost:${PORT}`);
  console.log(`  Supabase: ${process.env.SUPABASE_URL}`);
  console.log(`  Cron jobs: enabled (daily sync + weekly milestone check)`);
});

module.exports = app;
