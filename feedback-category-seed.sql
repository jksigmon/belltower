-- ======================================================================
-- Seeds a "Feedback & Bug Reports" request category so staff have a
-- dedicated, easy-to-find way to send questions/bugs/screenshots during
-- the beta, funneled through the existing Requests module.
--
-- Edit the two values below before running:
--   school_name   — exact schools.name for the school to seed this for
--   manager_email — profiles.email of the person who should receive/manage
--                   these submissions (you)
-- ======================================================================

DO $$
DECLARE
  v_school_id  uuid;
  v_manager_id uuid;
  v_category_id uuid;
BEGIN
  SELECT id INTO v_school_id FROM public.schools WHERE name = 'Revolution Academy';
  IF v_school_id IS NULL THEN
    RAISE EXCEPTION 'School not found — check the name against public.schools';
  END IF;

  SELECT id INTO v_manager_id FROM public.profiles
    WHERE school_id = v_school_id AND email = 'jksigmon@gmail.com';
  IF v_manager_id IS NULL THEN
    RAISE EXCEPTION 'Manager profile not found — check email against public.profiles for this school';
  END IF;

  INSERT INTO public.request_categories (school_id, name, description, created_by)
  VALUES (
    v_school_id,
    'Feedback & Bug Reports',
    'Found a bug, have a question, or want to suggest something? Let us know, this goes straight to the Belltower team.',
    v_manager_id
  )
  RETURNING id INTO v_category_id;

  INSERT INTO public.request_category_fields (category_id, label, field_type, is_required, sort_order)
  VALUES
    (v_category_id, 'Subject',               'text',     true,  0),
    (v_category_id, 'What happened / question', 'textarea', true,  1),
    (v_category_id, 'Screenshot (optional)', 'file',     false, 2);

  INSERT INTO public.request_category_managers (category_id, profile_id, added_by)
  VALUES (v_category_id, v_manager_id, v_manager_id);
END $$;
