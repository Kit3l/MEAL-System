/**
 * MEAL System — Node.js / Express API
 * ====================================
 * REST API backend connecting the frontend form to Supabase PostgreSQL.
 * Also handles KoboToolbox webhook + scheduled sync.
 *
 * Setup:
 *   npm init -y
 *   npm install express cors dotenv @supabase/supabase-js axios node-cron
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
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.ALLOWED_ORIGINS?.split(",") || "*" }));
app.use(express.json({ limit: "10mb" })); // ✏️ CHANGE 1: increased limit for file uploads

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
 * ✏️ CHANGE 2: include reporting_period in project insert
 * ✏️ CHANGE 3: fix milestone activity_id bug — strip client-side activity_id from milestones
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
      .insert(projectData) // reporting_period is now included in projectData from the form
      .select()
      .single();

    if (pErr) return dbErr(res, pErr);

    const projectId = project.id;
    const results   = { project, indicators: [], milestones: [], risks: [] };
    const partialErrors = []; // ✏️ collect any child-insert failures to report back

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
      if (indErr) {
        console.error("[indicators insert]", indErr.message);
        partialErrors.push({ section: "indicators", count: indRows.length, error: indErr.message });
      } else {
        results.indicators = indData;
      }
    }

    // 3. Insert milestones
    // ✏️ CHANGE 3: strip activity_id from milestones during registration —
    // the client sends client-side counter IDs (0,1,2) not real DB UUIDs.
    // Milestones are linked to the project only at registration time.
    if (milestones.length > 0) {
      const msRows = milestones.map((m, i) => {
        const { activity_id, ...milestoneData } = m; // strip junk client-side activity_id
        return {
          ...milestoneData,
          project_id: projectId,
          sort_order: i,
        };
      });
      const { data: msData, error: msErr } = await supabase
        .from("milestones")
        .insert(msRows)
        .select();
      if (msErr) {
        console.error("[milestones insert]", msErr.message);
        partialErrors.push({ section: "milestones", count: msRows.length, error: msErr.message });
      } else {
        results.milestones = msData;
      }
    }

    // 4. Insert risks
    if (risks.length > 0) {
      const riskRows = risks.map(r => ({ ...r, project_id: projectId }));
      const { data: riskData, error: riskErr } = await supabase
        .from("risks")
        .insert(riskRows)
        .select();
      if (riskErr) {
        console.error("[risks insert]", riskErr.message);
        partialErrors.push({ section: "risks", count: riskRows.length, error: riskErr.message });
      } else {
        results.risks = riskData;
      }
    }

    // ✏️ ITEM 3: The project itself was created, but one or more child sections
    // failed to insert. Report this back so the frontend can warn the user
    // instead of silently claiming full success.
    if (partialErrors.length > 0) {
      results.partial = true;
      results.partial_errors = partialErrors;
    }

    ok(res, results, 201);
  } catch (e) {
    err(res, e.message);
  }
});

/**
 * GET /api/projects/:id
 * Get a single project with all related data.
 * ✏️ CHANGE 4: include project_documents (project-level attachments) in response
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

    // ✏️ CHANGE 4: fetch project-level documents separately
    // (attachments where project_id matches and activity_id is null)
    const { data: projectDocs } = await supabase
      .from("attachments")
      .select("*")
      .eq("project_id", req.params.id)
      .is("activity_id", null)
      .order("created_at", { ascending: true });

    project.project_documents = projectDocs || [];

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
 * Soft-delete by setting status to 'closed'.
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
// PROJECT DOCUMENTS (project-level attachments — logframe, gantt, other)
// ✏️ CHANGE 5: all new routes for project document management
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/projects/:id/documents
 * List all project-level documents.
 */
app.get("/api/projects/:id/documents", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("attachments")
      .select("*")
      .eq("project_id", req.params.id)
      .is("activity_id", null)
      .order("created_at", { ascending: true });
    if (error) return dbErr(res, error);
    ok(res, data);
  } catch (e) { err(res, e.message); }
});

/**
 * POST /api/projects/:id/documents/upload-url
 * Generate a Supabase Storage presigned upload URL for the project-documents bucket.
 * Body: { file_name, file_type, document_type }
 * Returns: { upload_url, file_path, public_url }
 */
app.post("/api/projects/:id/documents/upload-url", async (req, res) => {
  const { file_name, file_type, document_type = "other" } = req.body;
  if (!file_name) return err(res, "file_name is required", 422);

  // Build a unique storage path: projects/{project_id}/{document_type}/{timestamp}_{file_name}
  const timestamp = Date.now();
  const safeName  = file_name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const filePath  = `projects/${req.params.id}/${document_type}/${timestamp}_${safeName}`;

  try {
    const { data, error } = await supabase.storage
      .from("project-documents")
      .createSignedUploadUrl(filePath);

    if (error) return dbErr(res, error);

    // Build the public URL for later download
    const { data: urlData } = supabase.storage
      .from("project-documents")
      .getPublicUrl(filePath);

    ok(res, {
      upload_url: data.signedUrl,
      token:      data.token,
      file_path:  filePath,
      public_url: urlData.publicUrl,
    });
  } catch (e) { err(res, e.message); }
});

/**
 * POST /api/projects/:id/documents
 * Save document metadata after frontend confirms upload to Storage.
 * Body: { file_name, file_size, file_type, file_path, public_url, document_type }
 */
app.post("/api/projects/:id/documents", async (req, res) => {
  try {
    const payload = {
      ...req.body,
      project_id:  req.params.id,
      activity_id: null, // explicitly null — this is a project-level document
      uploaded_at: new Date().toISOString(),
    };
    const { data, error } = await supabase
      .from("attachments")
      .insert(payload)
      .select()
      .single();
    if (error) return dbErr(res, error);
    ok(res, data, 201);
  } catch (e) { err(res, e.message); }
});

/**
 * DELETE /api/project-documents/:id
 * Delete a project document from Storage and the database.
 */
app.delete("/api/project-documents/:id", async (req, res) => {
  try {
    const { data: doc, error: fetchError } = await supabase
      .from("attachments")
      .select("file_path, project_id")
      .eq("id", req.params.id)
      .single();
    if (fetchError) return dbErr(res, fetchError);

    // Remove from project-documents bucket
    if (doc.file_path) {
      await supabase.storage
        .from("project-documents")
        .remove([doc.file_path]);
    }

    const { error } = await supabase
      .from("attachments")
      .delete()
      .eq("id", req.params.id);
    if (error) return dbErr(res, error);
    ok(res, { deleted: true });
  } catch (e) { err(res, e.message); }
});

// ─────────────────────────────────────────────────────────────────────────────
// ACTIVITIES (INDICATORS) — per-project
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/projects/:id/indicators
 * Add a single new activity/indicator to an existing project.
 */
app.post("/api/projects/:id/indicators", async (req, res) => {
  try {
    const payload = { ...req.body, project_id: req.params.id };
    const { data, error } = await supabase
      .from("indicators")
      .insert(payload)
      .select()
      .single();
    if (error) return dbErr(res, error);
    ok(res, data, 201);
  } catch (e) {
    err(res, e.message);
  }
});

/**
 * PATCH /api/projects/:id/indicators
 * Bulk-update actuals/targets for all indicators on a project.
 * Body: { updates: [{ id, baseline_value, overall_target, overall_actual }] }
 */
app.patch("/api/projects/:id/indicators", async (req, res) => {
  const { updates = [] } = req.body;
  if (!updates.length) return err(res, "No updates provided", 422);

  try {
    const results = [];
    for (const u of updates) {
      const { id, ...fields } = u;
      if (!id) continue;
      const { data, error } = await supabase
        .from("indicators")
        .update(fields)
        .eq("id", id)
        .eq("project_id", req.params.id)
        .select()
        .single();
      if (error) console.error(`[indicator update ${id}]`, error.message);
      else results.push(data);
    }
    ok(res, results);
  } catch (e) {
    err(res, e.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// MILESTONES / ACHIEVEMENTS — per-project
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/projects/:id/milestones
 * Add a new achievement to an existing project.
 */
app.post("/api/projects/:id/milestones", async (req, res) => {
  try {
    const payload = { ...req.body, project_id: req.params.id };
    const { data, error } = await supabase
      .from("milestones")
      .insert(payload)
      .select()
      .single();
    if (error) return dbErr(res, error);
    ok(res, data, 201);
  } catch (e) {
    err(res, e.message);
  }
});

/**
 * PATCH /api/projects/:id/milestones
 * Bulk-update status/due_date for all achievements on a project.
 * Body: { updates: [{ id, status, due_date }] }
 */
app.patch("/api/projects/:id/milestones", async (req, res) => {
  const { updates = [] } = req.body;
  if (!updates.length) return err(res, "No updates provided", 422);

  try {
    const results = [];
    for (const u of updates) {
      const { id, ...fields } = u;
      if (!id) continue;
      const { data, error } = await supabase
        .from("milestones")
        .update(fields)
        .eq("id", id)
        .eq("project_id", req.params.id)
        .select()
        .single();
      if (error) console.error(`[milestone update ${id}]`, error.message);
      else results.push(data);
    }
    ok(res, results);
  } catch (e) {
    err(res, e.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// INDIVIDUAL INDICATOR & MILESTONE ROUTES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * PATCH /api/indicators/:id
 * Update a single indicator (actuals, budget, impact, etc.)
 */
app.patch("/api/indicators/:id", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("indicators")
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
 * POST /api/indicators/:id/data
 * Submit indicator data for a reporting period.
 */
app.post("/api/indicators/:id/data", async (req, res) => {
  const { id } = req.params;
  const payload = { ...req.body, indicator_id: id };

  const { data: ind, error: indErr } = await supabase
    .from("indicators")
    .select("project_id, overall_target")
    .eq("id", id)
    .single();
  if (indErr) return dbErr(res, indErr);

  payload.project_id = ind.project_id;

  try {
    const { data, error } = await supabase
      .from("indicator_data")
      .upsert(payload, { onConflict: "indicator_id,reporting_period" })
      .select()
      .single();
    if (error) return dbErr(res, error);

    // Recalculate cumulative overall_actual
    const { data: rows } = await supabase
      .from("indicator_data")
      .select("actual_value")
      .eq("indicator_id", id);

    const cumulative = rows?.reduce((s, r) => s + (r.actual_value || 0), 0) || 0;
    await supabase.from("indicators").update({ overall_actual: cumulative }).eq("id", id);

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

/**
 * PATCH /api/milestones/:id
 * Update a single milestone/achievement.
 */
app.patch("/api/milestones/:id", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("milestones")
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
 * POST /api/activities/:id/achievements
 * Add a new achievement directly linked to an activity.
 */
app.post("/api/activities/:id/achievements", async (req, res) => {
  try {
    const payload = { ...req.body, activity_id: req.params.id };
    const { data, error } = await supabase
      .from("milestones")
      .insert(payload)
      .select()
      .single();
    if (error) return dbErr(res, error);
    ok(res, data, 201);
  } catch (e) {
    err(res, e.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// IMPACTS
// ─────────────────────────────────────────────────────────────────────────────

app.get("/api/projects/:id/impacts", async (req, res) => {
  const { data, error } = await supabase
    .from("impacts").select("*").eq("project_id", req.params.id)
    .order("created_at", { ascending: true });
  if (error) return dbErr(res, error);
  ok(res, data);
});

app.post("/api/impacts", async (req, res) => {
  const { data, error } = await supabase.from("impacts").insert(req.body).select().single();
  if (error) return dbErr(res, error);
  ok(res, data, 201);
});

app.patch("/api/impacts/:id", async (req, res) => {
  const { data, error } = await supabase
    .from("impacts").update(req.body).eq("id", req.params.id).select().single();
  if (error) return dbErr(res, error);
  ok(res, data);
});

app.delete("/api/impacts/:id", async (req, res) => {
  const { error } = await supabase.from("impacts").delete().eq("id", req.params.id);
  if (error) return dbErr(res, error);
  ok(res, { deleted: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// MEDIA LINKS
// ─────────────────────────────────────────────────────────────────────────────

app.get("/api/activities/:id/media", async (req, res) => {
  const { data, error } = await supabase
    .from("media_links").select("*").eq("activity_id", req.params.id)
    .order("created_at", { ascending: true });
  if (error) return dbErr(res, error);
  ok(res, data);
});

app.post("/api/media-links", async (req, res) => {
  const { data, error } = await supabase.from("media_links").insert(req.body).select().single();
  if (error) return dbErr(res, error);
  ok(res, data, 201);
});

app.delete("/api/media-links/:id", async (req, res) => {
  const { error } = await supabase.from("media_links").delete().eq("id", req.params.id);
  if (error) return dbErr(res, error);
  ok(res, { deleted: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// ATTACHMENTS (activity-level)
// ✏️ CHANGE 6: updated delete route to use correct bucket based on attachment type
// ─────────────────────────────────────────────────────────────────────────────

app.get("/api/activities/:id/attachments", async (req, res) => {
  const { data, error } = await supabase
    .from("attachments").select("*").eq("activity_id", req.params.id)
    .order("created_at", { ascending: true });
  if (error) return dbErr(res, error);
  ok(res, data);
});

app.post("/api/attachments", async (req, res) => {
  const { data, error } = await supabase.from("attachments").insert(req.body).select().single();
  if (error) return dbErr(res, error);
  ok(res, data, 201);
});

/**
 * DELETE /api/attachments/:id
 * ✏️ CHANGE 6: choose correct bucket based on whether attachment is
 * activity-level (activity-attachments) or project-level (project-documents)
 */
app.delete("/api/attachments/:id", async (req, res) => {
  const { data: attachment, error: fetchError } = await supabase
    .from("attachments")
    .select("file_path, activity_id, project_id")
    .eq("id", req.params.id)
    .single();
  if (fetchError) return dbErr(res, fetchError);

  // Route to the correct bucket
  const bucket = attachment.activity_id ? "activity-attachments" : "project-documents";
  if (attachment.file_path) {
    await supabase.storage.from(bucket).remove([attachment.file_path]);
  }

  const { error } = await supabase.from("attachments").delete().eq("id", req.params.id);
  if (error) return dbErr(res, error);
  ok(res, { deleted: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// BUDGET SUMMARY
// ─────────────────────────────────────────────────────────────────────────────

app.get("/api/projects/:id/budget", async (req, res) => {
  try {
    const { data: project, error: projError } = await supabase
      .from("projects").select("budget_usd, title, code").eq("id", req.params.id).single();
    if (projError) return dbErr(res, projError);

    const { data: activities, error: actError } = await supabase
      .from("indicators").select("id, name, budget_allocation").eq("project_id", req.params.id);
    if (actError) return dbErr(res, actError);

    const totalAllocated = activities.reduce((sum, a) => sum + (parseFloat(a.budget_allocation) || 0), 0);
    const remaining      = (parseFloat(project.budget_usd) || 0) - totalAllocated;
    const percentUsed    = project.budget_usd ? (totalAllocated / parseFloat(project.budget_usd)) * 100 : 0;

    let budgetStatus = "green";
    if (percentUsed >= 100) budgetStatus = "red";
    else if (percentUsed >= 85) budgetStatus = "orange";

    ok(res, {
      project_title:   project.title,
      project_code:    project.code,
      total_budget:    parseFloat(project.budget_usd) || 0,
      total_allocated: totalAllocated,
      remaining,
      percent_used:    Math.round(percentUsed),
      budget_status:   budgetStatus,
      activities:      activities.map(a => ({
        id: a.id, name: a.name,
        budget_allocation: parseFloat(a.budget_allocation) || 0,
      })),
    });
  } catch (e) {
    err(res, e.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DASHBOARD & ANALYTICS
// ─────────────────────────────────────────────────────────────────────────────

app.get("/api/dashboard", async (req, res) => {
  try {
    const [portfolio, overdue, highRisks] = await Promise.all([
      supabase.from("v_portfolio_dashboard").select("*"),
      supabase.from("v_overdue_milestones").select("*").limit(10),
      supabase.from("risks").select("*, projects(title,code)")
        .gte("risk_score", 6).eq("is_resolved", false)
        .order("risk_score", { ascending: false }).limit(10),
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

app.post("/api/kobo/webhook", async (req, res) => {
  const secret = req.headers["x-kobo-secret"] || req.query.secret;
  if (secret !== process.env.API_SECRET) return err(res, "Unauthorized", 401);

  const submission = req.body;
  console.log(`[KoboWebhook] Received submission ID: ${submission["_id"]}`);

  try {
    const mapped = mapKoboToIndicatorData(submission);
    if (!mapped) return ok(res, { message: "Submission received but no mapping matched" });

    const { data, error } = await supabase
      .from("indicator_data")
      .upsert(mapped, { onConflict: "indicator_id,reporting_period" })
      .select().single();

    if (error) return dbErr(res, error);
    ok(res, { message: "Submission processed", record: data });
  } catch (e) {
    err(res, e.message);
  }
});

app.post("/api/kobo/sync", async (req, res) => {
  const { asset_uid, project_id, indicator_id } = req.body;
  if (!asset_uid) return err(res, "asset_uid is required", 422);

  const { data: syncLog } = await supabase
    .from("kobo_sync_log")
    .insert({ project_id, kobo_asset_uid: asset_uid, sync_type: "pull", status: "running" })
    .select().single();

  const logId = syncLog?.id;
  res.status(202).json({ success: true, data: { message: "Sync started", log_id: logId } });

  runKoboSync(asset_uid, project_id, indicator_id, logId).catch(console.error);
});

app.post("/api/kobo/sync/:assetUid", async (req, res) => {
  const { assetUid } = req.params;
  const { project_id, indicator_id } = req.body;

  const { data: syncLog } = await supabase
    .from("kobo_sync_log")
    .insert({ project_id, kobo_asset_uid: assetUid, sync_type: "pull", status: "running" })
    .select().single();

  const logId = syncLog?.id;
  res.status(202).json({ success: true, data: { message: "Sync started", log_id: logId } });

  runKoboSync(assetUid, project_id, indicator_id, logId).catch(console.error);
});

app.get("/api/kobo/forms", async (req, res) => {
  try {
    const response = await axios.get(
      `${process.env.KOBO_BASE_URL}/api/v2/assets/?asset_type=survey`,
      { headers: { Authorization: `Token ${process.env.KOBO_API_TOKEN}` }, timeout: 10000 }
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

async function runKoboSync(assetUid, projectId, indicatorId, logId) {
  let inserted = 0, failed = 0;
  const errors = [];

  try {
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

        if (error) { failed++; errors.push({ id: sub["_id"], error: error.message }); }
        else inserted++;
      } catch (subErr) {
        failed++;
        errors.push({ id: sub["_id"], error: subErr.message });
      }
    }

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
    notes:              submission["monitoring/notes"] || null,
    data_source_type:   "kobo",
    kobo_submission_id: String(submission["_id"]),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SCHEDULED JOBS
// ✏️ CHANGE 7: fix cron job — use real kobo_asset_uid column instead of
// aliasing the description column
// ─────────────────────────────────────────────────────────────────────────────

cron.schedule("0 2 * * *", async () => {
  console.log("[Cron] Daily KoboToolbox sync starting…");
  const { data: projects } = await supabase
    .from("projects")
    .select("id, code, kobo_asset_uid") // ✏️ CHANGE 7: real column, no alias hack
    .eq("status", "active");

  if (!projects?.length) { console.log("[Cron] No active projects to sync."); return; }

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

cron.schedule("0 8 * * 1", async () => {
  console.log("[Cron] Checking overdue milestones…");
  const { data, error } = await supabase
    .from("v_overdue_milestones")
    .select("id, project_title, title, days_overdue");
  if (error) { console.error(error.message); return; }
  console.log(`[Cron] ${data?.length || 0} overdue milestone(s) found.`);
});

// ✏️ ITEM 2: Supabase keep-alive ping.
// The free tier pauses a project after ~7 days with no activity. This runs a
// lightweight query every 3 days so the database is never idle long enough to
// be paused. Harmless if the project is already active for other reasons.
cron.schedule("0 6 */3 * *", async () => {
  try {
    const { error } = await supabase.from("projects").select("id").limit(1);
    if (error) console.error("[Cron] Keep-alive ping failed:", error.message);
    else console.log("[Cron] Supabase keep-alive ping OK —", new Date().toISOString());
  } catch (e) {
    console.error("[Cron] Keep-alive ping error:", e.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// LOGFRAME
// ─────────────────────────────────────────────────────────────────────────────

app.get("/api/projects/:id/logframe", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("logframe_rows")
      .select("*")
      .eq("project_id", req.params.id)
      .order("sort_order", { ascending: true });
    if (error) return dbErr(res, error);
    ok(res, data);
  } catch (e) { err(res, e.message); }
});

app.post("/api/projects/:id/logframe", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("logframe_rows")
      .insert({ ...req.body, project_id: req.params.id })
      .select()
      .single();
    if (error) return dbErr(res, error);
    ok(res, data, 201);
  } catch (e) { err(res, e.message); }
});

app.patch("/api/logframe/:id", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("logframe_rows")
      .update(req.body)
      .eq("id", req.params.id)
      .select()
      .single();
    if (error) return dbErr(res, error);
    ok(res, data);
  } catch (e) { err(res, e.message); }
});

app.delete("/api/logframe/:id", async (req, res) => {
  try {
    const { error } = await supabase
      .from("logframe_rows")
      .delete()
      .eq("id", req.params.id);
    if (error) return dbErr(res, error);
    ok(res, { deleted: true });
  } catch (e) { err(res, e.message); }
});

// ─────────────────────────────────────────────────────────────────────────────
// EVALUATIONS
// ─────────────────────────────────────────────────────────────────────────────

app.get("/api/evaluations", async (req, res) => {
  try {
    let q = supabase
      .from("evaluations")
      .select("*, projects(title,code)")
      .order("created_at", { ascending: false });
    if (req.query.project_id) q = q.eq("project_id", req.query.project_id);
    const { data, error } = await q;
    if (error) return dbErr(res, error);
    ok(res, data);
  } catch (e) { err(res, e.message); }
});

app.post("/api/evaluations", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("evaluations")
      .insert(req.body)
      .select()
      .single();
    if (error) return dbErr(res, error);
    ok(res, data, 201);
  } catch (e) { err(res, e.message); }
});

app.patch("/api/evaluations/:id", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("evaluations")
      .update(req.body)
      .eq("id", req.params.id)
      .select()
      .single();
    if (error) return dbErr(res, error);
    ok(res, data);
  } catch (e) { err(res, e.message); }
});

app.delete("/api/evaluations/:id", async (req, res) => {
  try {
    const { error } = await supabase
      .from("evaluations")
      .delete()
      .eq("id", req.params.id);
    if (error) return dbErr(res, error);
    ok(res, { deleted: true });
  } catch (e) { err(res, e.message); }
});

// ─────────────────────────────────────────────────────────────────────────────
// LEARNING ENTRIES
// ─────────────────────────────────────────────────────────────────────────────

app.get("/api/learning", async (req, res) => {
  try {
    let q = supabase
      .from("learning_entries")
      .select("*, projects(title,code)")
      .order("created_at", { ascending: false });
    if (req.query.project_id) q = q.eq("project_id", req.query.project_id);
    const { data, error } = await q;
    if (error) return dbErr(res, error);
    ok(res, data);
  } catch (e) { err(res, e.message); }
});

app.post("/api/learning", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("learning_entries")
      .insert(req.body)
      .select()
      .single();
    if (error) return dbErr(res, error);
    ok(res, data, 201);
  } catch (e) { err(res, e.message); }
});

app.delete("/api/learning/:id", async (req, res) => {
  try {
    const { error } = await supabase
      .from("learning_entries")
      .delete()
      .eq("id", req.params.id);
    if (error) return dbErr(res, error);
    ok(res, { deleted: true });
  } catch (e) { err(res, e.message); }
});

// ─────────────────────────────────────────────────────────────────────────────
// DISSEMINATION PLANS
// ─────────────────────────────────────────────────────────────────────────────

app.get("/api/dissemination", async (req, res) => {
  try {
    let q = supabase
      .from("dissemination_plans")
      .select("*, projects(title,code)")
      .order("created_at", { ascending: false });
    if (req.query.project_id) q = q.eq("project_id", req.query.project_id);
    const { data, error } = await q;
    if (error) return dbErr(res, error);
    ok(res, data);
  } catch (e) { err(res, e.message); }
});

app.post("/api/dissemination", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("dissemination_plans")
      .insert(req.body)
      .select()
      .single();
    if (error) return dbErr(res, error);
    ok(res, data, 201);
  } catch (e) { err(res, e.message); }
});

app.patch("/api/dissemination/:id", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("dissemination_plans")
      .update(req.body)
      .eq("id", req.params.id)
      .select()
      .single();
    if (error) return dbErr(res, error);
    ok(res, data);
  } catch (e) { err(res, e.message); }
});

app.delete("/api/dissemination/:id", async (req, res) => {
  try {
    const { error } = await supabase
      .from("dissemination_plans")
      .delete()
      .eq("id", req.params.id);
    if (error) return dbErr(res, error);
    ok(res, { deleted: true });
  } catch (e) { err(res, e.message); }
});

// ─────────────────────────────────────────────────────────────────────────────
// STATIC FILES, HEALTH CHECK & START
// ─────────────────────────────────────────────────────────────────────────────

const path = require("path");

app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "MEAL API", version: "1.1.0", time: new Date().toISOString() });
});

// 404 handler — must come AFTER all routes
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