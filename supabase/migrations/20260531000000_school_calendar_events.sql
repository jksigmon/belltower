-- Migration: School calendar events table + Revolution Academy 2026-27 seed
-- Date: 2026-05-31

-- ── Table ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.school_calendar_events (
    id          uuid        DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    school_id   uuid        NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    title       text        NOT NULL,
    event_date  date        NOT NULL,
    end_date    date,                    -- NULL = single-day event
    event_type  text        NOT NULL DEFAULT 'no_school'
                            CHECK (event_type IN (
                                'no_school','holiday','pd_day',
                                'early_release','break','quarter_end','first_last_day'
                            )),
    notes       text,
    created_at  timestamptz DEFAULT now() NOT NULL
);

-- Index for the common query: upcoming events for a school
CREATE INDEX IF NOT EXISTS idx_cal_events_school_date
    ON public.school_calendar_events (school_id, event_date);

-- ── RLS ─────────────────────────────────────────────────────────────────
ALTER TABLE public.school_calendar_events ENABLE ROW LEVEL SECURITY;

-- All authenticated school members can read their school's events
CREATE POLICY "School members read calendar events"
ON public.school_calendar_events FOR SELECT
USING (
    school_id = (
        SELECT school_id FROM public.profiles
        WHERE user_id = auth.uid()
        LIMIT 1
    )
);

-- Admins can insert/update/delete
CREATE POLICY "Admins manage calendar events"
ON public.school_calendar_events FOR ALL
USING (
    EXISTS (
        SELECT 1 FROM public.profiles
        WHERE user_id   = auth.uid()
          AND school_id = school_calendar_events.school_id
          AND role      = 'admin'
    )
)
WITH CHECK (
    EXISTS (
        SELECT 1 FROM public.profiles
        WHERE user_id   = auth.uid()
          AND school_id = school_calendar_events.school_id
          AND role      = 'admin'
    )
);

-- ── calendar_pdf_url on schools ──────────────────────────────────────────
ALTER TABLE public.schools
    ADD COLUMN IF NOT EXISTS calendar_pdf_url text;

-- ── Seed: Revolution Academy 2026-27 ────────────────────────────────────
WITH ra AS (
    SELECT id FROM public.schools
    WHERE LOWER(name) LIKE '%revolution%'
    LIMIT 1
)
INSERT INTO public.school_calendar_events
    (school_id, title, event_date, end_date, event_type)
SELECT
    ra.id,
    v.title,
    v.event_date::date,
    v.end_date::date,
    v.event_type
FROM ra
CROSS JOIN (VALUES
-- August 2026
    ('New Staff PD',                        '2026-08-07', NULL,         'pd_day'),
    ('PD Week — No School for Students',    '2026-08-10', '2026-08-14', 'pd_day'),
    ('PD Days — No School for Students',    '2026-08-17', '2026-08-18', 'pd_day'),
    ('First Day of School',                 '2026-08-19', NULL,         'first_last_day'),
    ('Early Release',                       '2026-08-21', NULL,         'early_release'),
-- September 2026
    ('No School — Labor Day',               '2026-09-07', NULL,         'holiday'),
-- October 2026
    ('Q1 Ends',                             '2026-10-12', NULL,         'quarter_end'),
    ('Fall Break',                          '2026-10-14', '2026-10-16', 'break'),
    ('Parent-Teacher Conferences',          '2026-10-30', NULL,         'no_school'),
    ('No School',                           '2026-10-31', NULL,         'no_school'),
-- November 2026
    ('No School — Veterans Day',            '2026-11-11', NULL,         'holiday'),
    ('Thanksgiving Break',                  '2026-11-23', '2026-11-27', 'holiday'),
-- December 2026
    ('Q2 Ends',                             '2026-12-18', NULL,         'quarter_end'),
    ('Winter Break',                        '2026-12-21', '2026-12-31', 'break'),
-- January 2027
    ('No School — New Year''s Day',         '2027-01-01', NULL,         'holiday'),
    ('PD Day — No School for Students',     '2027-01-04', NULL,         'pd_day'),
    ('No School',                           '2027-01-15', NULL,         'no_school'),
    ('No School — MLK Day',                 '2027-01-18', NULL,         'holiday'),
-- February 2027
    ('No School — President''s Day',        '2027-02-12', NULL,         'holiday'),
    ('No School',                           '2027-02-15', NULL,         'no_school'),
-- March 2027
    ('Q3 Ends',                             '2027-03-05', NULL,         'quarter_end'),
    ('PD Day — No School for Students',     '2027-03-12', NULL,         'pd_day'),
    ('Early Release',                       '2027-03-25', NULL,         'early_release'),
    ('No School',                           '2027-03-26', NULL,         'no_school'),
    ('Spring Break',                        '2027-03-29', '2027-04-02', 'break'),
-- April 2027
    ('No School',                           '2027-04-26', NULL,         'no_school'),
    ('Early Release',                       '2027-04-28', NULL,         'early_release'),
-- May 2027
    ('Last Day of School',                  '2027-05-19', NULL,         'first_last_day')
) AS v(title, event_date, end_date, event_type)
WHERE ra.id IS NOT NULL
ON CONFLICT DO NOTHING;
