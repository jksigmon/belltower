-- ============================================================
-- CEU renewal requirements as data, not a hardcoded JS rule.
--
-- admin.licensure.js and staff.html each hardcoded their own copy of
-- ceuTargetProfile()/CEU_CATEGORY_LABELS (NC's 8-credit-per-5-year CPL
-- renewal split by role/grade band). That's a duplicated static document:
-- every renewal cycle it needs re-verifying against NC SBE Policy LICN-005
-- (16 NCAC 06C .0362 for teachers/support, .0363 for administrators), and
-- until now a correction required a code deploy in two places at once.
--
-- Verified against the current LICN-005 text (Board Policy Manual, last
-- revised 02/04/2021 -- the "licenses expiring on or after June 30, 2019"
-- table, which is still the active version) on 2026-09-20:
--   Grades K-5:            3 Subject Area   / 3 Literacy               / 2 Digital Learning
--   Grades 6-12:           3 Subject Area   / 3 General                / 2 Digital Learning
--   Student Services:      3 Prof. Discipline / 3 General              / 2 Digital Learning
--   Administrators:        3 Executive's Role / 3 General              / 2 Digital Learning
-- These numbers match what admin.licensure.js already had hardcoded --
-- the prior 3/3/2 split was NOT a flat universal rule, it already branched
-- by staff_licenses.category and .grade_authorization. What it did NOT do
-- is check license_type: a non-CPL license (IPL, Residency, Emergency,
-- Permit, CTE_Provisional) doesn't carry this 8-credit/5-year renewal
-- requirement at all, but the old code applied the CPL profile to any
-- teaching/admin/support license regardless of type. The app-side fix
-- (admin.shared.js ceuTargetProfile) now gates on license_type = 'CPL'.
--
-- grade_band is NULL for admin/support since NC's grade-band split only
-- applies to classroom teachers; staff_licenses.grade_authorization values
-- of 'K-6' and 'K-12' both map to the K-5 profile (elementary generalists),
-- 'K-12' single-subject areas (e.g. art, PE) are an approximation not
-- distinguished by the data model today -- flagged in notes, not fixed
-- here, since staff_licenses has no field for that distinction.
-- ============================================================

CREATE TABLE public.ceu_renewal_requirements (
    id                uuid DEFAULT gen_random_uuid() NOT NULL,
    staff_category    text NOT NULL,   -- matches staff_licenses.category: teaching | admin | support
    grade_band        text,            -- matches staff_licenses.grade_authorization; NULL = not grade-banded
    total_credits     numeric NOT NULL DEFAULT 8,
    category_targets  jsonb NOT NULL,  -- {"literacy":3,"content":3,"digital_learning":2}
    source_citation   text NOT NULL,
    last_verified_date date NOT NULL,
    notes             text,
    created_at        timestamp with time zone DEFAULT now() NOT NULL,
    updated_at        timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ceu_renewal_requirements_pkey PRIMARY KEY (id),
    CONSTRAINT ceu_renewal_requirements_category_check CHECK (staff_category = ANY (ARRAY['teaching'::text, 'admin'::text, 'support'::text])),
    CONSTRAINT ceu_renewal_requirements_unique UNIQUE (staff_category, grade_band)
);

CREATE TRIGGER trg_ceu_renewal_requirements_updated_at BEFORE UPDATE ON public.ceu_renewal_requirements
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.ceu_renewal_requirements ENABLE ROW LEVEL SECURITY;

-- No anon policy exists below (read requires auth.uid() IS NOT NULL), so no anon grant.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ceu_renewal_requirements TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ceu_renewal_requirements TO service_role;

-- Not school-scoped (NC state law applies the same everywhere this app is
-- deployed) and not sensitive, so any authenticated user may read it --
-- staff need it client-side for their own CEU progress panel in staff.html.
CREATE POLICY "CEU requirements: authenticated select" ON public.ceu_renewal_requirements
    FOR SELECT USING (auth.uid() IS NOT NULL);

CREATE POLICY "CEU requirements: admin manage" ON public.ceu_renewal_requirements
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM public.profiles p
            WHERE p.user_id = auth.uid()
              AND p.status = 'active'
              AND (p.is_superadmin OR p.can_manage_licensure)
        )
    );

INSERT INTO public.ceu_renewal_requirements
    (staff_category, grade_band, total_credits, category_targets, source_citation, last_verified_date, notes)
VALUES
    ('teaching', 'K-6',  8, '{"literacy":3,"content":3,"digital_learning":2}'::jsonb,
        'NC SBE Policy LICN-005 (rev. 02/04/2021); 16 NCAC 06C .0362', '2026-09-20',
        'Grades K-5 renewal split. Applies to CPL license_type only.'),
    ('teaching', 'K-12', 8, '{"literacy":3,"content":3,"digital_learning":2}'::jsonb,
        'NC SBE Policy LICN-005 (rev. 02/04/2021); 16 NCAC 06C .0362', '2026-09-20',
        'Treated as elementary generalist (K-5 split). A K-12 single-subject license (art, PE, music) would actually fall under the 6-12 split for secondary assignments -- staff_licenses has no field to distinguish; verify manually if this comes up.'),
    ('teaching', '6-9',  8, '{"content":3,"general_other":3,"digital_learning":2}'::jsonb,
        'NC SBE Policy LICN-005 (rev. 02/04/2021); 16 NCAC 06C .0362', '2026-09-20',
        'Grades 6-12 renewal split.'),
    ('teaching', '9-12', 8, '{"content":3,"general_other":3,"digital_learning":2}'::jsonb,
        'NC SBE Policy LICN-005 (rev. 02/04/2021); 16 NCAC 06C .0362', '2026-09-20',
        'Grades 6-12 renewal split.'),
    ('admin',    NULL,   8, '{"administration":3,"general_other":3,"digital_learning":2}'::jsonb,
        'NC SBE Policy LICN-005 (rev. 02/04/2021); 16 NCAC 06C .0363', '2026-09-20',
        '"administration" category = Executive''s Role (NC School Executive Standards 2, 4, 5).'),
    ('support',  NULL,   8, '{"professional_discipline":3,"general_other":3,"digital_learning":2}'::jsonb,
        'NC SBE Policy LICN-005 (rev. 02/04/2021); 16 NCAC 06C .0362', '2026-09-20',
        'Counselors, media specialists, school psychologists, social workers, etc. Speech-language pathologists/audiologists with an active NC Board of Examiners license are statutorily exempt from this renewal-credit requirement entirely -- not modeled here, flag manually if this comes up.');
