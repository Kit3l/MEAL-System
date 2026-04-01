-- ============================================================
--  MEAL SYSTEM — PostgreSQL Schema
--  Compatible with Supabase (PostgreSQL 15+)
--  Run this in your Supabase SQL editor or psql
-- ============================================================

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- ENUMS
-- ============================================================

CREATE TYPE project_status   AS ENUM ('planning','active','review','closed');
CREATE TYPE result_level     AS ENUM ('activity','output','outcome','impact');
CREATE TYPE frequency_type   AS ENUM ('monthly','quarterly','semi_annual','annual','ad_hoc');
CREATE TYPE milestone_status AS ENUM ('not_started','in_progress','completed','delayed','cancelled');
CREATE TYPE risk_level       AS ENUM ('low','medium','high','critical');
CREATE TYPE user_role        AS ENUM ('admin','me_officer','project_manager','field_officer','viewer');
CREATE TYPE data_source_type AS ENUM ('kobo','odk','manual','api','csv_import');

-- ============================================================
-- USERS
-- ============================================================

CREATE TABLE users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email         TEXT UNIQUE NOT NULL,
    full_name     TEXT NOT NULL,
    organisation  TEXT,
    role          user_role NOT NULL DEFAULT 'viewer',
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    avatar_url    TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- PROJECTS
-- ============================================================

CREATE TABLE projects (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Identification
    title               TEXT NOT NULL,
    code                TEXT UNIQUE NOT NULL,
    status              project_status NOT NULL DEFAULT 'planning',
    thematic_area       TEXT,
    description         TEXT,

    -- Funding
    organisation        TEXT NOT NULL,
    donor               TEXT,
    budget_usd          NUMERIC(15,2),

    -- Timeline
    start_date          DATE NOT NULL,
    end_date            DATE NOT NULL,
    reporting_period    frequency_type NOT NULL DEFAULT 'quarterly',

    -- Geography
    country             TEXT NOT NULL DEFAULT 'Kenya',
    county_region       TEXT,
    sub_county          TEXT,
    gps_lat             NUMERIC(10,7),
    gps_lng             NUMERIC(10,7),

    -- Beneficiaries
    beneficiaries_total   INTEGER,
    beneficiaries_female  INTEGER,
    beneficiaries_male    INTEGER,

    -- Team
    project_manager       TEXT,
    pm_email              TEXT,
    me_officer            TEXT,
    me_officer_email      TEXT,

    -- Theory of change
    problem_statement     TEXT,
    theory_of_change      TEXT,
    key_assumptions       TEXT,

    -- Meta
    created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- INDICATORS (Performance Framework)
-- ============================================================

CREATE TABLE indicators (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id          UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

    name                TEXT NOT NULL,
    description         TEXT,
    result_level        result_level NOT NULL DEFAULT 'output',
    unit_of_measurement TEXT NOT NULL DEFAULT 'Number',
    data_source         TEXT,
    collection_method   TEXT,
    collection_frequency frequency_type NOT NULL DEFAULT 'quarterly',
    disaggregation      TEXT[],        -- e.g. ['sex','age_group','location']
    is_custom           BOOLEAN DEFAULT FALSE,
    sort_order          INTEGER DEFAULT 0,

    -- Baseline
    baseline_value      NUMERIC,
    baseline_year       INTEGER,
    baseline_source     TEXT,

    -- Targets & Actuals (stored per reporting period in indicator_data)
    overall_target      NUMERIC,
    overall_actual      NUMERIC,
    achievement_rate    NUMERIC GENERATED ALWAYS AS (
        CASE WHEN overall_target > 0
             THEN ROUND((overall_actual / overall_target) * 100, 2)
             ELSE NULL END
    ) STORED,

    -- Quality
    data_quality_notes  TEXT,
    verification_source TEXT,
    assumptions         TEXT,

    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- INDICATOR DATA (Time-series reporting values)
-- ============================================================

CREATE TABLE indicator_data (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    indicator_id    UUID NOT NULL REFERENCES indicators(id) ON DELETE CASCADE,
    project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

    reporting_period    TEXT NOT NULL,   -- e.g. 'Q1-2025', 'Jan-2025'
    period_start        DATE NOT NULL,
    period_end          DATE NOT NULL,

    target_value        NUMERIC,
    actual_value        NUMERIC,
    cumulative_actual   NUMERIC,
    achievement_rate    NUMERIC GENERATED ALWAYS AS (
        CASE WHEN target_value > 0
             THEN ROUND((actual_value / target_value) * 100, 2)
             ELSE NULL END
    ) STORED,

    -- Disaggregation (JSON for flexibility)
    disaggregated_data  JSONB DEFAULT '{}',  -- e.g. {"female":120,"male":80}

    data_source_type    data_source_type DEFAULT 'manual',
    kobo_submission_id  TEXT,       -- link back to KoboToolbox submission
    notes               TEXT,
    verified_by         UUID REFERENCES users(id),
    verified_at         TIMESTAMPTZ,

    submitted_by    UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE(indicator_id, reporting_period)
);

-- ============================================================
-- MILESTONES
-- ============================================================

CREATE TABLE milestones (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

    title           TEXT NOT NULL,
    description     TEXT,
    due_date        DATE,
    completion_date DATE,
    status          milestone_status NOT NULL DEFAULT 'not_started',
    responsible     TEXT,
    responsible_email TEXT,
    completion_pct  INTEGER DEFAULT 0 CHECK (completion_pct BETWEEN 0 AND 100),
    sort_order      INTEGER DEFAULT 0,
    notes           TEXT,

    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- RISKS & ASSUMPTIONS
-- ============================================================

CREATE TABLE risks (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

    title           TEXT NOT NULL,
    description     TEXT,
    risk_type       TEXT DEFAULT 'risk',  -- 'risk' or 'assumption'
    likelihood      risk_level NOT NULL DEFAULT 'medium',
    impact          risk_level NOT NULL DEFAULT 'medium',
    risk_score      INTEGER GENERATED ALWAYS AS (
        CASE
            WHEN likelihood='low'      AND impact='low'      THEN 1
            WHEN likelihood='low'      AND impact='medium'   THEN 2
            WHEN likelihood='low'      AND impact='high'     THEN 3
            WHEN likelihood='medium'   AND impact='low'      THEN 2
            WHEN likelihood='medium'   AND impact='medium'   THEN 4
            WHEN likelihood='medium'   AND impact='high'     THEN 6
            WHEN likelihood='high'     AND impact='low'      THEN 3
            WHEN likelihood='high'     AND impact='medium'   THEN 6
            WHEN likelihood='high'     AND impact='high'     THEN 9
            WHEN likelihood='critical' THEN 12
            ELSE 4
        END
    ) STORED,
    mitigation      TEXT,
    contingency     TEXT,
    owner           TEXT,
    review_date     DATE,
    is_resolved     BOOLEAN DEFAULT FALSE,

    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- LEARNING ENTRIES (The "L" in MEAL)
-- ============================================================

CREATE TABLE learning_entries (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

    title           TEXT NOT NULL,
    entry_type      TEXT DEFAULT 'lesson',  -- lesson, reflection, best_practice, challenge
    description     TEXT NOT NULL,
    recommendations TEXT,
    applicable_to   TEXT,   -- other projects/sectors this applies to
    reporting_period TEXT,
    tags            TEXT[],

    created_by    UUID REFERENCES users(id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- KOBO SYNC LOG (Integration tracking)
-- ============================================================

CREATE TABLE kobo_sync_log (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id          UUID REFERENCES projects(id) ON DELETE SET NULL,
    kobo_asset_uid      TEXT NOT NULL,
    sync_type           TEXT DEFAULT 'pull',     -- pull | webhook
    records_fetched     INTEGER DEFAULT 0,
    records_inserted    INTEGER DEFAULT 0,
    records_updated     INTEGER DEFAULT 0,
    records_failed      INTEGER DEFAULT 0,
    error_log           JSONB DEFAULT '[]',
    started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at        TIMESTAMPTZ,
    status              TEXT DEFAULT 'running'   -- running | success | failed
);

-- ============================================================
-- AUDIT LOG
-- ============================================================

CREATE TABLE audit_log (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    table_name  TEXT NOT NULL,
    record_id   UUID,
    action      TEXT NOT NULL,      -- INSERT | UPDATE | DELETE
    old_data    JSONB,
    new_data    JSONB,
    changed_by  UUID REFERENCES users(id),
    changed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- INDEXES (performance)
-- ============================================================

CREATE INDEX idx_projects_status        ON projects(status);
CREATE INDEX idx_projects_country       ON projects(country);
CREATE INDEX idx_projects_thematic      ON projects(thematic_area);
CREATE INDEX idx_projects_created_by    ON projects(created_by);
CREATE INDEX idx_indicators_project     ON indicators(project_id);
CREATE INDEX idx_indicator_data_proj    ON indicator_data(project_id);
CREATE INDEX idx_indicator_data_period  ON indicator_data(reporting_period);
CREATE INDEX idx_milestones_project     ON milestones(project_id);
CREATE INDEX idx_milestones_status      ON milestones(status);
CREATE INDEX idx_milestones_due         ON milestones(due_date);
CREATE INDEX idx_risks_project          ON risks(project_id);
CREATE INDEX idx_risks_score            ON risks(risk_score);
CREATE INDEX idx_learning_project       ON learning_entries(project_id);
CREATE INDEX idx_kobo_log_project       ON kobo_sync_log(project_id);
CREATE INDEX idx_audit_table_record     ON audit_log(table_name, record_id);

-- ============================================================
-- UPDATED_AT TRIGGER (auto-updates the timestamp)
-- ============================================================

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_projects_updated_at        BEFORE UPDATE ON projects        FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_indicators_updated_at      BEFORE UPDATE ON indicators      FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_indicator_data_updated_at  BEFORE UPDATE ON indicator_data  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_milestones_updated_at      BEFORE UPDATE ON milestones      FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_risks_updated_at           BEFORE UPDATE ON risks           FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_learning_updated_at        BEFORE UPDATE ON learning_entries FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_users_updated_at           BEFORE UPDATE ON users           FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- AUDIT TRIGGER (logs every change)
-- ============================================================

CREATE OR REPLACE FUNCTION log_audit()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO audit_log(table_name, record_id, action, old_data, new_data)
  VALUES (
    TG_TABLE_NAME,
    COALESCE(NEW.id, OLD.id),
    TG_OP,
    CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE NULL END,
    CASE WHEN TG_OP != 'DELETE' THEN to_jsonb(NEW) ELSE NULL END
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER audit_projects   AFTER INSERT OR UPDATE OR DELETE ON projects   FOR EACH ROW EXECUTE FUNCTION log_audit();
CREATE TRIGGER audit_indicators AFTER INSERT OR UPDATE OR DELETE ON indicators FOR EACH ROW EXECUTE FUNCTION log_audit();
CREATE TRIGGER audit_ind_data   AFTER INSERT OR UPDATE OR DELETE ON indicator_data FOR EACH ROW EXECUTE FUNCTION log_audit();

-- ============================================================
-- VIEWS (useful pre-built queries)
-- ============================================================

-- Project summary with indicator counts
CREATE VIEW v_project_summary AS
SELECT
    p.id,
    p.code,
    p.title,
    p.status,
    p.thematic_area,
    p.country,
    p.start_date,
    p.end_date,
    p.beneficiaries_total,
    COUNT(DISTINCT i.id)                    AS indicator_count,
    COUNT(DISTINCT m.id)                    AS milestone_count,
    COUNT(DISTINCT r.id)                    AS risk_count,
    AVG(i.achievement_rate)                 AS avg_achievement_rate,
    COUNT(DISTINCT m.id) FILTER (WHERE m.status = 'completed') AS milestones_completed,
    COUNT(DISTINCT r.id) FILTER (WHERE r.risk_score >= 6)       AS high_risks
FROM projects p
LEFT JOIN indicators    i ON i.project_id = p.id
LEFT JOIN milestones    m ON m.project_id = p.id
LEFT JOIN risks         r ON r.project_id = p.id
GROUP BY p.id;

-- Portfolio-level achievement dashboard
CREATE VIEW v_portfolio_dashboard AS
SELECT
    thematic_area,
    country,
    COUNT(*)                                            AS project_count,
    SUM(beneficiaries_total)                            AS total_beneficiaries,
    AVG((SELECT AVG(achievement_rate) FROM indicators WHERE project_id = p.id)) AS avg_achievement,
    COUNT(*) FILTER (WHERE status = 'active')           AS active_projects,
    COUNT(*) FILTER (WHERE status = 'closed')           AS completed_projects
FROM projects p
GROUP BY thematic_area, country;

-- Indicator progress with traffic-light flag
CREATE VIEW v_indicator_progress AS
SELECT
    i.id,
    i.project_id,
    p.code  AS project_code,
    p.title AS project_title,
    i.name  AS indicator_name,
    i.result_level,
    i.unit_of_measurement,
    i.baseline_value,
    i.overall_target,
    i.overall_actual,
    i.achievement_rate,
    CASE
        WHEN i.achievement_rate >= 80 THEN 'on_track'
        WHEN i.achievement_rate >= 50 THEN 'at_risk'
        ELSE 'off_track'
    END AS traffic_light
FROM indicators i
JOIN projects p ON p.id = i.project_id;

-- Overdue milestones
CREATE VIEW v_overdue_milestones AS
SELECT
    m.*,
    p.title AS project_title,
    p.code  AS project_code,
    (CURRENT_DATE - m.due_date) AS days_overdue
FROM milestones m
JOIN projects p ON p.id = m.project_id
WHERE m.due_date < CURRENT_DATE
  AND m.status NOT IN ('completed','cancelled')
ORDER BY days_overdue DESC;

-- ============================================================
-- SAMPLE DATA (for testing — remove in production)
-- ============================================================

INSERT INTO users (id, email, full_name, organisation, role)
VALUES
  (gen_random_uuid(), 'admin@mealsystem.org',   'System Admin',     'Monitoring Unit', 'admin'),
  (gen_random_uuid(), 'meo@mealsystem.org',     'Jane Wanjiku',     'Monitoring Unit', 'me_officer'),
  (gen_random_uuid(), 'pm@mealsystem.org',      'David Ochieng',    'Programme Team',  'project_manager');

INSERT INTO projects (
    title, code, status, thematic_area, description,
    organisation, donor, budget_usd,
    start_date, end_date, reporting_period,
    country, county_region, sub_county,
    beneficiaries_total, beneficiaries_female, beneficiaries_male,
    project_manager, pm_email, me_officer, me_officer_email
) VALUES (
    'Integrated WASH & Nutrition Programme Turkana',
    'KE-2025-WASH-001',
    'active',
    'WASH',
    'Improving access to safe water, sanitation and hygiene with integrated nutrition support for 12,500 households in Turkana County.',
    'Kenya Relief Organisation',
    'USAID',
    1250000.00,
    '2025-01-01', '2026-12-31',
    'quarterly',
    'Kenya', 'Turkana', 'Loima, Turkana West',
    12500, 6800, 5700,
    'David Ochieng', 'pm@mealsystem.org',
    'Jane Wanjiku', 'meo@mealsystem.org'
);
