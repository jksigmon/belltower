--
-- PostgreSQL database dump
--

-- \restrict R8XqRlAFK6vJqOKtwtgdaGgMqEF9KdOsxeGbmDh1pbnXfdExSWRJscB8q6yhfAf

-- Dumped from database version 17.6
-- Dumped by pg_dump version 17.6

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
-- SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: pg_database_owner
--

CREATE SCHEMA IF NOT EXISTS "public";


ALTER SCHEMA "public" OWNER TO "pg_database_owner";

--
-- Name: SCHEMA "public"; Type: COMMENT; Schema: -; Owner: pg_database_owner
--

COMMENT ON SCHEMA "public" IS 'standard public schema';


--
-- Name: call_type; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE "public"."call_type" AS ENUM (
    'FAMILY',
    'BUS',
    'ALL'
);


ALTER TYPE "public"."call_type" OWNER TO "postgres";

--
-- Name: carline_call_status; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE "public"."carline_call_status" AS ENUM (
    'WAITING',
    'CALLED',
    'RECALLED',
    'LOADED'
);


ALTER TYPE "public"."carline_call_status" OWNER TO "postgres";

--
-- Name: pto_status; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE "public"."pto_status" AS ENUM (
    'PENDING',
    'APPROVED',
    'DENIED',
    'CANCEL_REQUESTED',
    'CANCELLED',
    'RESCIND_REQUESTED',
    'RESCINDED'
);


ALTER TYPE "public"."pto_status" OWNER TO "postgres";

--
-- Name: role_type; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE "public"."role_type" AS ENUM (
    'admin',
    'staff',
    'front office'
);


ALTER TYPE "public"."role_type" OWNER TO "postgres";

--
-- Name: TYPE "role_type"; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TYPE "public"."role_type" IS 'Role Types';


--
-- Name: assert_carpool_student_same_school(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE OR REPLACE FUNCTION "public"."assert_carpool_student_same_school"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
    carpool_school uuid;
    student_school uuid;
BEGIN
    SELECT school_id INTO carpool_school FROM public.carpools WHERE id = NEW.carpool_id;
    SELECT school_id INTO student_school FROM public.students WHERE id = NEW.student_id;

    IF carpool_school IS DISTINCT FROM student_school THEN
        RAISE EXCEPTION
            'Student and pickup tag belong to different schools.';
    END IF;

    RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."assert_carpool_student_same_school"() OWNER TO "postgres";

--
-- Name: assert_carpool_tag_free(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE OR REPLACE FUNCTION "public"."assert_carpool_tag_free"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
    conflict_label text;
BEGIN
    IF NEW.tag_number IS NULL THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'UPDATE'
       AND NEW.tag_number IS NOT DISTINCT FROM OLD.tag_number
       AND NEW.school_id IS NOT DISTINCT FROM OLD.school_id THEN
        RETURN NEW;
    END IF;

    SELECT COALESCE(NULLIF(f.family_name, ''), '(Unnamed family)')
      INTO conflict_label
      FROM public.families f
     WHERE f.school_id = NEW.school_id
       AND f.carline_tag_number = NEW.tag_number
     LIMIT 1;

    IF conflict_label IS NOT NULL THEN
        RAISE EXCEPTION
            'Number % is already the family number for %. Family numbers and pickup tags share one pool -- pick a different number, or free that family number first.',
            NEW.tag_number, conflict_label;
    END IF;

    RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."assert_carpool_tag_free"() OWNER TO "postgres";

--
-- Name: assert_family_tag_free(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE OR REPLACE FUNCTION "public"."assert_family_tag_free"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
    conflict_label text;
BEGIN
    IF NEW.carline_tag_number IS NULL THEN
        RETURN NEW;
    END IF;

    -- Only re-check when the number (or school) actually moves, so unrelated
    -- edits to an already-colliding legacy row aren't blocked.
    IF TG_OP = 'UPDATE'
       AND NEW.carline_tag_number IS NOT DISTINCT FROM OLD.carline_tag_number
       AND NEW.school_id IS NOT DISTINCT FROM OLD.school_id THEN
        RETURN NEW;
    END IF;

    SELECT COALESCE(c.label, 'Pickup tag #' || c.tag_number)
      INTO conflict_label
      FROM public.carpools c
     WHERE c.school_id = NEW.school_id
       AND c.tag_number = NEW.carline_tag_number
     LIMIT 1;

    IF conflict_label IS NOT NULL THEN
        RAISE EXCEPTION
            'Number % is already in use by the pickup tag "%". Family numbers and pickup tags share one pool -- pick a different number, or renumber that pickup tag first.',
            NEW.carline_tag_number, conflict_label;
    END IF;

    RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."assert_family_tag_free"() OWNER TO "postgres";

--
-- Name: assign_student_number(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE OR REPLACE FUNCTION "public"."assign_student_number"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
declare
  next_num integer;
begin
  -- ✅ If student_number already provided (bulk upload or admin input),
  -- do NOTHING
  if new.student_number is not null then
    return new;
  end if;

  -- ✅ Ensure a sequence row exists for this school
  insert into public.school_student_sequences (school_id)
  values (new.school_id)
  on conflict (school_id) do nothing;

  -- ✅ Atomically increment and fetch next number
  update public.school_student_sequences
  set
    next_number = next_number + 1,
    updated_at = now()
  where school_id = new.school_id
  returning next_number - 1 into next_num;

  -- ✅ Assign the generated number
  new.student_number := lpad(next_num::text, 6, '0');

  return new;
end;
$$;


ALTER FUNCTION "public"."assign_student_number"() OWNER TO "postgres";

--
-- Name: claim_or_create_profile_for_user(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE OR REPLACE FUNCTION "public"."claim_or_create_profile_for_user"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  normalized_email text;
  email_domain text;
  emp record;
  matched_school_id uuid;
begin
  -- Normalize email from auth context
  normalized_email := lower(trim(auth.email()));
  email_domain := split_part(normalized_email, '@', 2);

  ------------------------------------------------------------------
  -- 1️⃣ Try to claim an existing (preloaded) profile
  ------------------------------------------------------------------
  update profiles
  set user_id   = auth.uid(),
      status    = 'active',
      can_login = true
  where user_id is null
    and lower(email) = normalized_email;

  if found then
    return;
  end if;

  ------------------------------------------------------------------
  -- 2️⃣ If employee exists, create a PENDING profile from employee
  ------------------------------------------------------------------
  select *
  into emp
  from employees
  where lower(email) = normalized_email
  limit 1;

  if found then
    insert into profiles (
      user_id,
      email,
      display_name,
      role,
      status,
      can_login,
      school_id
    )
    values (
      auth.uid(),
      normalized_email,
      concat(emp.first_name, ' ', emp.last_name),
      'staff',
      'pending',
      false,
      emp.school_id
    )
    on conflict (email) do nothing;

    return;
  end if;

  ------------------------------------------------------------------
  -- 3️⃣ Fallback: ALWAYS create a pending profile (domain optional)
  ------------------------------------------------------------------
  select sd.school_id
  into matched_school_id
  from school_domains sd
  where lower(sd.domain) = email_domain
  limit 1;

  insert into profiles (
    user_id,
    email,
    display_name,
    role,
    status,
    can_login,
    school_id
  )
  values (
    auth.uid(),
    normalized_email,
    split_part(normalized_email, '@', 1),
    'staff',
    'pending',
    false,
    matched_school_id -- may be NULL, this is OK
  )
  on conflict (email) do nothing;

end;
$$;


ALTER FUNCTION "public"."claim_or_create_profile_for_user"() OWNER TO "postgres";

--
-- Name: claim_profile_for_user(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE OR REPLACE FUNCTION "public"."claim_profile_for_user"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  update profiles
  set user_id = auth.uid(),
      status = 'active',
      can_login = true
  where user_id is null
    and lower(email) = lower(auth.email());
end;
$$;


ALTER FUNCTION "public"."claim_profile_for_user"() OWNER TO "postgres";

--
-- Name: compliance_volunteer_match_key("text", "text"); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE OR REPLACE FUNCTION "public"."compliance_volunteer_match_key"("p_first_name" "text", "p_last_name" "text") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    AS $$
  SELECT
    lower(trim(regexp_replace(coalesce(p_last_name, ''), '\s*\([^)]*\)\s*', ' ', 'g')))
    || '|' ||
    lower(split_part(trim(regexp_replace(coalesce(p_first_name, ''), '\s*\([^)]*\)\s*', ' ', 'g')), ' ', 1))
$$;


ALTER FUNCTION "public"."compliance_volunteer_match_key"("p_first_name" "text", "p_last_name" "text") OWNER TO "postgres";

--
-- Name: compute_intake_match(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE OR REPLACE FUNCTION "public"."compute_intake_match"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_guardian_id uuid;
  v_candidates  jsonb := '[]'::jsonb;
  v_confidence  text  := 'none';
  v_norm_sub    text;
  v_norm_g      text;
BEGIN
  -- 1. Email exact match → HIGH (100)
  IF NEW.email IS NOT NULL AND NEW.email <> '' THEN
    SELECT id INTO v_guardian_id
    FROM guardians
    WHERE school_id = NEW.school_id
      AND active    = true
      AND lower(trim(email)) = lower(trim(NEW.email))
    LIMIT 1;

    IF FOUND THEN
      v_candidates := jsonb_build_array(
        jsonb_build_object('guardian_id', v_guardian_id, 'score', 100, 'reasons', jsonb_build_array('email_exact'))
      );
      v_confidence := 'high';
      NEW.match_confidence := v_confidence;
      NEW.match_candidates := v_candidates;
      RETURN NEW;
    END IF;
  END IF;

  -- 2. Phone exact match (digits only) → HIGH (90)
  IF NEW.phone_cell IS NOT NULL AND NEW.phone_cell <> '' THEN
    v_norm_sub := regexp_replace(NEW.phone_cell, '\D', '', 'g');
    IF length(v_norm_sub) >= 7 THEN
      SELECT id INTO v_guardian_id
      FROM guardians
      WHERE school_id = NEW.school_id
        AND active    = true
        AND regexp_replace(phone, '\D', '', 'g') = v_norm_sub
      LIMIT 1;

      IF FOUND THEN
        v_candidates := jsonb_build_array(
          jsonb_build_object('guardian_id', v_guardian_id, 'score', 90, 'reasons', jsonb_build_array('phone_match'))
        );
        v_confidence := 'high';
        NEW.match_confidence := v_confidence;
        NEW.match_candidates := v_candidates;
        RETURN NEW;
      END IF;
    END IF;
  END IF;

  -- 3. First + last name exact match → MEDIUM (70)
  IF NEW.first_name IS NOT NULL AND NEW.last_name IS NOT NULL THEN
    SELECT id INTO v_guardian_id
    FROM guardians
    WHERE school_id  = NEW.school_id
      AND active     = true
      AND lower(trim(first_name)) = lower(trim(NEW.first_name))
      AND lower(trim(last_name))  = lower(trim(NEW.last_name))
    LIMIT 1;

    IF FOUND THEN
      v_candidates := jsonb_build_array(
        jsonb_build_object('guardian_id', v_guardian_id, 'score', 70, 'reasons', jsonb_build_array('name_exact'))
      );
      v_confidence := 'medium';
    END IF;
  END IF;

  NEW.match_confidence := v_confidence;
  NEW.match_candidates := v_candidates;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."compute_intake_match"() OWNER TO "postgres";

--
-- Name: convert_placement_teacher_to_placeholder(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE OR REPLACE FUNCTION "public"."convert_placement_teacher_to_placeholder"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  UPDATE public.placement_session_teachers
  SET
    placeholder_name = OLD.first_name || ' ' || OLD.last_name || ' (departed)',
    teacher_id       = NULL
  WHERE teacher_id = OLD.id;
  RETURN OLD;
END;
$$;


ALTER FUNCTION "public"."convert_placement_teacher_to_placeholder"() OWNER TO "postgres";

--
-- Name: create_profile_for_new_user(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE OR REPLACE FUNCTION "public"."create_profile_for_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  email_domain text;
  matched_school_id uuid;
  default_display_name text;
begin
  -- Normalize email
  new.email := lower(trim(new.email));

  email_domain := split_part(new.email, '@', 2);
  default_display_name := split_part(new.email, '@', 1);

  -- Match school by domain
  select sd.school_id
  into matched_school_id
  from public.school_domains sd
  where lower(sd.domain) = email_domain
  limit 1;

  -- Atomic claim-or-create
  insert into public.profiles (
    user_id,
    school_id,
    role,
    display_name,
    email,
    status,
    is_superadmin,
    can_login,
    can_view_carline,
    can_view_pto_calendar,
    can_review_pto,
    can_approve_pto,
    can_adjust_pto,
    can_bulk_upload,
    can_manage_guardians,
    can_access_admin,
    can_generate_pto_reports,
    can_manage_access,
    can_manage_staff,
    can_manage_families,
    can_manage_substitutes,
    can_manage_students,
    can_manage_bus_groups
  )
  values (
    new.id,
    matched_school_id,
    'staff',
    default_display_name,
    new.email,
    'active',
    false,
    true,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false
  )
  on conflict on constraint profiles_unique_email
  do update
    set user_id   = excluded.user_id,
        status    = 'active',
        can_login = true
  where profiles.user_id is null;

  return new;
end;
$$;


ALTER FUNCTION "public"."create_profile_for_new_user"() OWNER TO "postgres";

--
-- Name: current_user_can_manage_access(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE OR REPLACE FUNCTION "public"."current_user_can_manage_access"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    SET "row_security" TO 'off'
    AS $$
  select
    coalesce(
      bool_or(can_manage_access or is_superadmin),
      false
    )
  from profiles
  where user_id = auth.uid();
$$;


ALTER FUNCTION "public"."current_user_can_manage_access"() OWNER TO "postgres";

--
-- Name: current_user_can_manage_licensure("uuid"); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE OR REPLACE FUNCTION "public"."current_user_can_manage_licensure"("target_school_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    SET "row_security" TO 'off'
    AS $$
  select coalesce(
    bool_or(
      status = 'active' AND (
        is_superadmin = true
        OR (can_manage_licensure = true AND school_id = target_school_id)
      )
    ),
    false
  )
  from profiles
  where user_id = auth.uid();
$$;


ALTER FUNCTION "public"."current_user_can_manage_licensure"("target_school_id" "uuid") OWNER TO "postgres";

--
-- Name: current_user_can_manage_requests(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE OR REPLACE FUNCTION "public"."current_user_can_manage_requests"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    SET "row_security" TO 'off'
    AS $$
  select
    coalesce(
      bool_or(can_manage_requests),
      false
    )
  from profiles
  where user_id = auth.uid();
$$;


ALTER FUNCTION "public"."current_user_can_manage_requests"() OWNER TO "postgres";

--
-- Name: current_user_can_manage_substitutes("uuid"); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE OR REPLACE FUNCTION "public"."current_user_can_manage_substitutes"("target_school_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    SET "row_security" TO 'off'
    AS $$
  select coalesce(
    bool_or(school_id = target_school_id AND status = 'active' AND can_manage_substitutes = true),
    false
  )
  from profiles
  where user_id = auth.uid();
$$;


ALTER FUNCTION "public"."current_user_can_manage_substitutes"("target_school_id" "uuid") OWNER TO "postgres";

--
-- Name: current_user_can_view_trip("uuid", "uuid", "uuid"); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE OR REPLACE FUNCTION "public"."current_user_can_view_trip"("target_school_id" "uuid", "trip_id" "uuid", "trip_creator" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    SET "row_security" TO 'off'
    AS $$
  select coalesce(
    bool_or(
      is_superadmin OR (
        school_id = target_school_id AND status = 'active' AND (
          can_manage_field_trips = true
          OR id = trip_creator
          OR public.ft_is_manager(trip_id, id)
        )
      )
    ),
    false
  )
  from profiles
  where user_id = auth.uid();
$$;


ALTER FUNCTION "public"."current_user_can_view_trip"("target_school_id" "uuid", "trip_id" "uuid", "trip_creator" "uuid") OWNER TO "postgres";

--
-- Name: current_user_is_active_in_school("uuid"); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE OR REPLACE FUNCTION "public"."current_user_is_active_in_school"("target_school_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    SET "row_security" TO 'off'
    AS $$
  select coalesce(
    bool_or(is_superadmin OR (school_id = target_school_id AND status = 'active')),
    false
  )
  from profiles
  where user_id = auth.uid();
$$;


ALTER FUNCTION "public"."current_user_is_active_in_school"("target_school_id" "uuid") OWNER TO "postgres";

--
-- Name: current_user_manages_submitter("uuid"); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE OR REPLACE FUNCTION "public"."current_user_manages_submitter"("p_submitter_profile_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    SET "row_security" TO 'off'
    AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.staff_requests sr
    JOIN public.request_category_managers rcm ON rcm.category_id = sr.category_id
    WHERE sr.submitted_by = p_submitter_profile_id
      AND rcm.profile_id = public.current_user_profile_id()
  );
$$;


ALTER FUNCTION "public"."current_user_manages_submitter"("p_submitter_profile_id" "uuid") OWNER TO "postgres";

--
-- Name: current_user_profile_id(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE OR REPLACE FUNCTION "public"."current_user_profile_id"() RETURNS "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    SET "row_security" TO 'off'
    AS $$
  SELECT id
  FROM public.profiles
  WHERE user_id = auth.uid()
  LIMIT 1;
$$;


ALTER FUNCTION "public"."current_user_profile_id"() OWNER TO "postgres";

--
-- Name: current_user_school_id(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE OR REPLACE FUNCTION "public"."current_user_school_id"() RETURNS "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    SET "row_security" TO 'off'
    AS $$
  select school_id
  from profiles
  where user_id = auth.uid()
  limit 1;
$$;


ALTER FUNCTION "public"."current_user_school_id"() OWNER TO "postgres";

--
-- Name: enforce_fallback_approver_has_pto_access(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE OR REPLACE FUNCTION "public"."enforce_fallback_approver_has_pto_access"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  if new.is_fallback_approver = true and new.can_approve_pto = false then
    raise exception 'Fallback approver must also have PTO approval access';
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."enforce_fallback_approver_has_pto_access"() OWNER TO "postgres";

--
-- Name: enforce_reservation_insert_status(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE OR REPLACE FUNCTION "public"."enforce_reservation_insert_status"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_privileged          boolean;
  v_requires_approval   boolean;
  v_active              boolean;
  v_resource_school_id  uuid;
begin
  select (p.is_superadmin = true or p.role = 'admin' or p.can_manage_reservations = true)
    into v_privileged
  from profiles p
  where p.user_id = auth.uid();

  select requires_approval, active, school_id
    into v_requires_approval, v_active, v_resource_school_id
  from reservable_resources
  where id = new.resource_id;

  if v_resource_school_id is null or v_resource_school_id <> new.school_id then
    raise exception 'Resource does not belong to this school.';
  end if;

  if not coalesce(v_active, false) then
    raise exception 'This resource is not currently accepting bookings.';
  end if;

  if coalesce(v_privileged, false) then
    return new;
  end if;

  if new.status not in ('pending', 'confirmed') then
    raise exception 'Invalid initial reservation status.';
  end if;

  if coalesce(v_requires_approval, false) and new.status <> 'pending' then
    raise exception 'This resource requires approval -- the reservation must start as pending.';
  end if;

  if new.decided_by is not null or new.decided_at is not null then
    raise exception 'Only an admin can set the decision fields.';
  end if;

  return new;
end;
$$;


ALTER FUNCTION "public"."enforce_reservation_insert_status"() OWNER TO "postgres";

--
-- Name: enforce_reservation_owner_update(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE OR REPLACE FUNCTION "public"."enforce_reservation_owner_update"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_privileged boolean;
begin
  select (p.is_superadmin = true or p.role = 'admin' or p.can_manage_reservations = true)
    into v_privileged
  from profiles p
  where p.user_id = auth.uid();

  if coalesce(v_privileged, false) then
    return new;
  end if;

  -- Non-privileged callers only reach here because reservations_update's
  -- USING clause already confirmed they own this row. The UI only ever
  -- lets an owner cancel their own booking, so that's all this allows --
  -- everything else (self-approving a pending request, changing the
  -- resource/time after the client-side overlap check already ran,
  -- forging decided_by/decided_at) is rejected.
  if new.status <> 'cancelled'
     or new.resource_id            is distinct from old.resource_id
     or new.starts_at              is distinct from old.starts_at
     or new.ends_at                is distinct from old.ends_at
     or new.school_id              is distinct from old.school_id
     or new.reserved_by_profile_id is distinct from old.reserved_by_profile_id
     or new.decided_by             is distinct from old.decided_by
     or new.decided_at             is distinct from old.decided_at
  then
    raise exception 'You can only cancel your own reservation.';
  end if;

  return new;
end;
$$;


ALTER FUNCTION "public"."enforce_reservation_owner_update"() OWNER TO "postgres";

--
-- Name: enforce_supervisor_is_pto_approver(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE OR REPLACE FUNCTION "public"."enforce_supervisor_is_pto_approver"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if new.supervisor_id is null then
    return new;
  end if;

  if not exists (
    select 1
    from profiles p
    where p.employee_id = new.supervisor_id
      and p.can_approve_pto = true
  ) then
    raise exception 'Supervisor must have PTO approval access';
  end if;

  return new;
end;
$$;


ALTER FUNCTION "public"."enforce_supervisor_is_pto_approver"() OWNER TO "postgres";

--
-- Name: ft_get_school_id("uuid"); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE OR REPLACE FUNCTION "public"."ft_get_school_id"("trip_id" "uuid") RETURNS "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT school_id FROM public.field_trips WHERE id = trip_id;
$$;


ALTER FUNCTION "public"."ft_get_school_id"("trip_id" "uuid") OWNER TO "postgres";

--
-- Name: ft_is_manager("uuid", "uuid"); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE OR REPLACE FUNCTION "public"."ft_is_manager"("trip_id" "uuid", "prof_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.field_trip_managers
    WHERE field_trip_id = trip_id AND profile_id = prof_id
  );
$$;


ALTER FUNCTION "public"."ft_is_manager"("trip_id" "uuid", "prof_id" "uuid") OWNER TO "postgres";

--
-- Name: get_calendar_ics_link(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE OR REPLACE FUNCTION "public"."get_calendar_ics_link"() RETURNS TABLE("school_id" "uuid", "calendar_ics_token" "uuid")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    SET "row_security" TO 'off'
    AS $$
  SELECT s.id, s.calendar_ics_token
  FROM public.schools s
  JOIN public.profiles p ON p.school_id = s.id
  WHERE p.user_id = auth.uid()
    AND p.status = 'active'
    AND (p.is_superadmin = true OR p.can_manage_access = true);
$$;


ALTER FUNCTION "public"."get_calendar_ics_link"() OWNER TO "postgres";

--
-- Name: get_trip_managers("uuid"); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE OR REPLACE FUNCTION "public"."get_trip_managers"("trip_id" "uuid") RETURNS TABLE("profile_id" "uuid")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
 SELECT profile_id FROM public.field_trip_managers WHERE field_trip_id = trip_id;
$$;


ALTER FUNCTION "public"."get_trip_managers"("trip_id" "uuid") OWNER TO "postgres";

--
-- Name: handle_new_auth_user(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE OR REPLACE FUNCTION "public"."handle_new_auth_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
begin
  insert into public.profiles (
    user_id,
    email,
    status,
    can_login,
    is_superadmin
  )
  values (
    new.id,
    new.email,
    'active',      -- ✅ rollout mode
    true,
    false
  )
  on conflict (user_id) do nothing;

  return new;
end;
$$;


ALTER FUNCTION "public"."handle_new_auth_user"() OWNER TO "postgres";

--
-- Name: handle_pto_ledger_insert(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE OR REPLACE FUNCTION "public"."handle_pto_ledger_insert"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    SET "row_security" TO 'off'
    AS $$
BEGIN
  INSERT INTO public.pto_balances (
    school_id,
    employee_id,
    pto_type,
    balance_hours,
    updated_at
  )
  VALUES (
    NEW.school_id,        -- ✅ FIX: propagate school_id
    NEW.employee_id,
    NEW.pto_type,
    NEW.delta_hours,
    now()
  )
  ON CONFLICT (employee_id, pto_type)
  DO UPDATE
    SET balance_hours =
          pto_balances.balance_hours + EXCLUDED.balance_hours,
        updated_at = now();

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."handle_pto_ledger_insert"() OWNER TO "postgres";

--
-- Name: handle_pto_status_change(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE OR REPLACE FUNCTION "public"."handle_pto_status_change"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$begin
  if tg_op = 'UPDATE' and new.status <> old.status then

    -- 🔒 Guard: RESCINDED can ONLY come from RESCIND_REQUESTED
    if new.status = 'RESCINDED'
       and old.status <> 'RESCIND_REQUESTED' then
      raise exception 'Invalid PTO state transition to RESCINDED';
    end if;

    -- ✅ APPROVAL: subtract requested hours (ONLY if balance-counting PTO)
if new.status = 'APPROVED'
   and old.status <> 'RESCIND_REQUESTED'
   and exists (
     select 1
     from public.school_pto_types t
     where t.school_id = new.school_id
       and t.pto_type = new.pto_type::text
       and t.counts_against_balance = true
   )
   and not exists (
     select 1
     from public.pto_ledger l
     where l.related_request_id = new.id
       and l.delta_hours < 0
   ) then

  insert into public.pto_ledger (
    school_id,
    employee_id,
    pto_type,
    delta_hours,
    reason,
    related_request_id,
    created_by
  )
  values (
    new.school_id,
    new.employee_id,
    new.pto_type,
    -new.requested_hours,
    'REQUEST APPROVED',
    new.id,
    new.decided_by
  );


-- ✅ FUTURE PTO CANCELLATION → credit back
elsif (
  new.status = 'CANCELLED'
  and old.status in ('APPROVED', 'CANCEL_REQUESTED')

  -- ✅ Only if this PTO type counts against balance
  and exists (
    select 1
    from public.school_pto_types t
    where t.school_id = new.school_id
      and t.pto_type = new.pto_type::text
      and t.counts_against_balance = true
  )

  -- ✅ Only if a debit was previously recorded
  and exists (
    select 1
    from public.pto_ledger l
    where l.related_request_id = new.id
      and l.delta_hours < 0
  )
) then

  insert into public.pto_ledger (
    school_id,
    employee_id,
    pto_type,
    delta_hours,
    reason,
    related_request_id,
    created_by
  )
  values (
    new.school_id,
    new.employee_id,
    new.pto_type,
    new.requested_hours,
    'REQUEST CANCELLED FUTURE',
    new.id,
    new.decided_by
  );


-- ✅ RETROACTIVE PTO RESCIND → credit back
elsif (
  new.status = 'RESCINDED'
  and old.status = 'RESCIND_REQUESTED'

  -- ✅ Only if this PTO type counts against balance
  and exists (
    select 1
    from public.school_pto_types t
    where t.school_id = new.school_id
      and t.pto_type = new.pto_type::text
      and t.counts_against_balance = true
  )

  -- ✅ Only if a debit was previously recorded
  and exists (
    select 1
    from public.pto_ledger l
    where l.related_request_id = new.id
      and l.delta_hours < 0
  )
) then

  insert into public.pto_ledger (
    school_id,
    employee_id,
    pto_type,
    delta_hours,
    reason,
    related_request_id,
    created_by
  )
  values (
    new.school_id,
    new.employee_id,
    new.pto_type,
    new.requested_hours,
    'REQUEST RESCINDED RETROACTIVE',
    new.id,
    new.decided_by
  );

    end if;

  end if;

  return new;
end;$$;


ALTER FUNCTION "public"."handle_pto_status_change"() OWNER TO "postgres";

--
-- Name: is_request_category_manager("uuid", "uuid"); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE OR REPLACE FUNCTION "public"."is_request_category_manager"("p_category_id" "uuid", "p_user_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.request_category_managers rcm
    JOIN public.profiles p ON p.id = rcm.profile_id
    WHERE rcm.category_id = p_category_id AND p.user_id = p_user_id
  );
$$;


ALTER FUNCTION "public"."is_request_category_manager"("p_category_id" "uuid", "p_user_id" "uuid") OWNER TO "postgres";

--
-- Name: is_request_category_visible_to("uuid", "uuid"); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE OR REPLACE FUNCTION "public"."is_request_category_visible_to"("p_category_id" "uuid", "p_user_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.request_category_visibility rcv
    JOIN public.profiles p ON p.id = rcv.profile_id
    WHERE rcv.category_id = p_category_id AND p.user_id = p_user_id
  );
$$;


ALTER FUNCTION "public"."is_request_category_visible_to"("p_category_id" "uuid", "p_user_id" "uuid") OWNER TO "postgres";

--
-- Name: log_permission_changes(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE OR REPLACE FUNCTION "public"."log_permission_changes"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  old_json jsonb := to_jsonb(OLD);
  new_json jsonb := to_jsonb(NEW);
  tracked_fields text[] := ARRAY[
    'can_login', 'can_access_admin', 'can_manage_access',
    'can_manage_staff', 'can_manage_students', 'can_manage_placement',
    'can_manage_families', 'can_manage_guardians', 'can_manage_bus_groups',
    'can_manage_carpools', 'can_manage_substitutes',
    'can_view_carline', 'can_manage_carline',
    'can_manage_campuses', 'can_manage_calendar',
    'can_manage_resource_docs', 'can_manage_reservations', 'can_manage_inventory',
    'can_manage_licensure', 'can_manage_compliance', 'can_manage_field_trips',
    'can_manage_requests', 'can_bulk_upload', 'can_export_data',
    'can_view_pto_calendar', 'can_review_pto', 'can_approve_pto',
    'can_submit_on_behalf', 'is_fallback_approver',
    'can_adjust_pto', 'can_manage_pto_balances', 'can_generate_pto_reports'
  ];
  field text;
  changer_id uuid;
BEGIN
  SELECT id INTO changer_id FROM public.profiles WHERE user_id = auth.uid();

  FOREACH field IN ARRAY tracked_fields LOOP
    IF old_json -> field IS DISTINCT FROM new_json -> field THEN
      INSERT INTO public.permission_audit_log
        (school_id, target_profile_id, changed_by_profile_id, field_name, old_value, new_value)
      VALUES (
        NEW.school_id, NEW.id, changer_id, field,
        (old_json ->> field)::boolean, (new_json ->> field)::boolean
      );
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."log_permission_changes"() OWNER TO "postgres";

--
-- Name: notify_pto_event(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE OR REPLACE FUNCTION "public"."notify_pto_event"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$BEGIN
  PERFORM
    net.http_post(
      url := 'https://xrhwjjkxlshfarlxuxsa.functions.supabase.co/send_pto_notifications',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'apikey', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhyaHdqamt4bHNoZmFybHh1eHNhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3MzY0OTcsImV4cCI6MjA5MTMxMjQ5N30.Gf4oUa33DzIkc3fHwbyq-xc6Ptqq1jMFBzPCQM8dT-s',
        'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhyaHdqamt4bHNoZmFybHh1eHNhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3MzY0OTcsImV4cCI6MjA5MTMxMjQ5N30.Gf4oUa33DzIkc3fHwbyq-xc6Ptqq1jMFBzPCQM8dT-s'
      ),
      body := jsonb_build_object(
        'event', TG_OP,
        'old_status', OLD.status,
        'new_status', NEW.status,
        'pto_request_id', NEW.id
      )
    );

  RETURN NEW;
END;$$;


ALTER FUNCTION "public"."notify_pto_event"() OWNER TO "postgres";

--
-- Name: prevent_school_delete(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE OR REPLACE FUNCTION "public"."prevent_school_delete"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  IF NOT OLD.deletable THEN
    RAISE EXCEPTION
      'School "%" is protected from deletion. Run: UPDATE schools SET deletable = true WHERE id = ''%''; — then retry.',
      OLD.name, OLD.id;
  END IF;
  RETURN OLD;
END;
$$;


ALTER FUNCTION "public"."prevent_school_delete"() OWNER TO "postgres";

--
-- Name: regenerate_calendar_ics_token(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE OR REPLACE FUNCTION "public"."regenerate_calendar_ics_token"() RETURNS TABLE("school_id" "uuid", "calendar_ics_token" "uuid")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    SET "row_security" TO 'off'
    AS $$
DECLARE
  caller_school_id uuid;
BEGIN
  SELECT p.school_id INTO caller_school_id
  FROM public.profiles p
  WHERE p.user_id = auth.uid()
    AND p.status = 'active'
    AND (p.is_superadmin = true OR p.role = 'admin');

  IF caller_school_id IS NULL THEN
    RAISE EXCEPTION 'Not authorized to regenerate the calendar link.';
  END IF;

  RETURN QUERY
  UPDATE public.schools
  SET calendar_ics_token = gen_random_uuid()
  WHERE id = caller_school_id
  RETURNING schools.id, schools.calendar_ics_token;
END;
$$;


ALTER FUNCTION "public"."regenerate_calendar_ics_token"() OWNER TO "postgres";

--
-- Name: rls_auto_enable(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE OR REPLACE FUNCTION "public"."rls_auto_enable"() RETURNS "event_trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog'
    AS $$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$$;


ALTER FUNCTION "public"."rls_auto_enable"() OWNER TO "postgres";

--
-- Name: set_updated_at(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE OR REPLACE FUNCTION "public"."set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."set_updated_at"() OWNER TO "postgres";

--
-- Name: sync_last_sign_in(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE OR REPLACE FUNCTION "public"."sync_last_sign_in"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
  UPDATE public.profiles
  SET last_sign_in_at = NEW.last_sign_in_at
  WHERE user_id = NEW.id;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."sync_last_sign_in"() OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";

--
-- Name: access_requests; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."access_requests" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "school_id" "uuid" NOT NULL,
    "employee_id" "uuid" NOT NULL,
    "requested_permissions" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "reason" "text",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "admin_note" "text",
    "reviewed_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "access_requests_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'approved'::"text", 'denied'::"text"])))
);


ALTER TABLE "public"."access_requests" OWNER TO "postgres";

--
-- Name: bulk_upload_logs; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."bulk_upload_logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "uploaded_by" "uuid" NOT NULL,
    "uploaded_at" timestamp with time zone DEFAULT "now"(),
    "mode" "text" NOT NULL,
    "summary" "jsonb",
    "filename" "text",
    "school_id" "uuid",
    "selected_sheets" "text"[],
    "error_count" integer DEFAULT 0 NOT NULL,
    "blocking_errors" boolean DEFAULT false NOT NULL,
    "rows" "jsonb"
);


ALTER TABLE "public"."bulk_upload_logs" OWNER TO "postgres";

--
-- Name: bus_groups; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."bus_groups" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "school_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "route_number" "text",
    "route_type" "text",
    "driver" "text",
    "monitor" "text",
    "capacity" integer,
    CONSTRAINT "bus_groups_route_type_check" CHECK (("route_type" = ANY (ARRAY['AM'::"text", 'PM'::"text", 'AM/PM'::"text"])))
);


ALTER TABLE "public"."bus_groups" OWNER TO "postgres";

--
-- Name: campuses; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."campuses" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "school_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "day_start_time" time without time zone,
    "day_end_time" time without time zone,
    "workday_hours" numeric(4,2),
    "pto_increment_minutes" integer,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."campuses" OWNER TO "postgres";

--
-- Name: carline_bus_arrivals; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."carline_bus_arrivals" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "school_id" "uuid" NOT NULL,
    "carline_event_id" "uuid" NOT NULL,
    "bus_group_id" "uuid" NOT NULL,
    "called_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "called_by_profile_id" "uuid",
    "recalled_at" timestamp with time zone
);


ALTER TABLE "public"."carline_bus_arrivals" OWNER TO "postgres";

--
-- Name: carline_calls; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."carline_calls" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "school_id" "uuid" NOT NULL,
    "carline_event_id" "uuid" NOT NULL,
    "student_id" "uuid" NOT NULL,
    "family_id" "uuid",
    "status" "public"."carline_call_status" DEFAULT 'WAITING'::"public"."carline_call_status" NOT NULL,
    "called_by_user_id" "uuid",
    "called_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "call_type" "text" DEFAULT ''::"text",
    "recalled_at" timestamp with time zone,
    "loaded_at" timestamp with time zone,
    "called_by_profile_id" "uuid"
);


ALTER TABLE "public"."carline_calls" OWNER TO "postgres";

--
-- Name: carline_events; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."carline_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "school_id" "uuid" NOT NULL,
    "name" "text",
    "event_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "status" "text",
    "closed_at" timestamp with time zone,
    "closed_by_user_id" "uuid",
    "created_by_profile_id" "uuid",
    "closed_by_profile_id" "uuid",
    "campus_id" "uuid",
    "all_call_at" timestamp with time zone
);


ALTER TABLE "public"."carline_events" OWNER TO "postgres";

--
-- Name: carline_pickup_groups; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."carline_pickup_groups" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "school_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "campus_id" "uuid",
    "grade_levels" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."carline_pickup_groups" OWNER TO "postgres";

--
-- Name: carline_tags; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."carline_tags" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "carpool_id" "uuid" NOT NULL,
    "family_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."carline_tags" OWNER TO "postgres";

--
-- Name: TABLE "carline_tags"; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE "public"."carline_tags" IS 'Family members of a pickup tag. Calling the tag calls every student in each listed family.';


--
-- Name: carpool_students; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."carpool_students" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "carpool_id" "uuid" NOT NULL,
    "student_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."carpool_students" OWNER TO "postgres";

--
-- Name: TABLE "carpool_students"; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE "public"."carpool_students" IS 'Individual student members of a pickup tag. Calling the tag calls only these students -- used where one child must be callable without their siblings (split/blended households).';


--
-- Name: carpools; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."carpools" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "school_id" "uuid" NOT NULL,
    "tag_number" "text" NOT NULL,
    "label" "text",
    "active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."carpools" OWNER TO "postgres";

--
-- Name: TABLE "carpools"; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE "public"."carpools" IS 'Pickup tags (shown in the UI as "Pickup Tags"). An extra dismissal number that calls a set of member families (carline_tags) and/or individual students (carpool_students). Named "carpools" historically, when families were the only member type. Shares one number pool with families.carline_tag_number -- see assert_carpool_tag_free.';


--
-- Name: compliance_agreements; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."compliance_agreements" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "school_id" "uuid" NOT NULL,
    "template_id" "uuid" NOT NULL,
    "form_link_id" "uuid",
    "signer_name" "text" NOT NULL,
    "signer_email" "text" NOT NULL,
    "signature_type" "text" NOT NULL,
    "signature_data" "text" NOT NULL,
    "content_hash" "text",
    "ip_address" "text",
    "user_agent" "text",
    "signed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "expires_at" "date",
    "voided_at" timestamp with time zone,
    "voided_by" "uuid",
    "guardian_id" "uuid",
    "family_id" "uuid",
    "link_status" "text" DEFAULT 'unresolved'::"text" NOT NULL,
    "student_name_hint" "text",
    "carline_tag_hint" "text",
    "submitted_phone" "text",
    "submitted_relationship" "text",
    "submitted_data_reviewed" boolean DEFAULT false NOT NULL,
    "archived_at" timestamp with time zone,
    CONSTRAINT "compliance_agreements_link_status_check" CHECK (("link_status" = ANY (ARRAY['auto_linked'::"text", 'manual_linked'::"text", 'unresolved'::"text"]))),
    CONSTRAINT "compliance_agreements_signature_type_check" CHECK (("signature_type" = ANY (ARRAY['draw'::"text", 'typed'::"text"])))
);


ALTER TABLE "public"."compliance_agreements" OWNER TO "postgres";

--
-- Name: compliance_bg_check_requests; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."compliance_bg_check_requests" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "school_id" "uuid" NOT NULL,
    "requestor_id" "uuid",
    "subject_first_name" "text" NOT NULL,
    "subject_last_name" "text" NOT NULL,
    "subject_email" "text",
    "reason" "text",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "requested_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "submitted_at" timestamp with time zone,
    "cleared_at" timestamp with time zone,
    "expires_at" "date",
    "notes" "text",
    "admin_note" "text",
    "volunteer_roles" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "mvr_cleared_at" "date",
    "mvr_expires_at" "date",
    "archived_at" timestamp with time zone,
    "guardian_id" "uuid",
    "imported_at" timestamp with time zone,
    "volunteer_id" "uuid",
    CONSTRAINT "compliance_bg_check_requests_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'submitted'::"text", 'cleared'::"text", 'expired'::"text", 'cancelled'::"text", 'declined'::"text"])))
);


ALTER TABLE "public"."compliance_bg_check_requests" OWNER TO "postgres";

--
-- Name: compliance_form_links; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."compliance_form_links" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "school_id" "uuid" NOT NULL,
    "template_id" "uuid" NOT NULL,
    "token" character(32) NOT NULL,
    "label" "text",
    "expires_at" "date",
    "active" boolean DEFAULT true NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."compliance_form_links" OWNER TO "postgres";

--
-- Name: compliance_form_templates; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."compliance_form_templates" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "school_id" "uuid" NOT NULL,
    "title" "text" NOT NULL,
    "description" "text",
    "body_html" "text" DEFAULT ''::"text" NOT NULL,
    "active" boolean DEFAULT true NOT NULL,
    "content_hash" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "required_for_chaperones" boolean DEFAULT false NOT NULL,
    "require_signature" boolean DEFAULT true NOT NULL
);


ALTER TABLE "public"."compliance_form_templates" OWNER TO "postgres";

--
-- Name: COLUMN "compliance_form_templates"."require_signature"; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN "public"."compliance_form_templates"."require_signature" IS 'When false, the form collects name and email only (no drawn/typed signature). Submission is recorded as acknowledged.';


--
-- Name: compliance_report_grants; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."compliance_report_grants" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "school_id" "uuid" NOT NULL,
    "grantee_id" "uuid" NOT NULL,
    "teacher_id" "uuid" NOT NULL,
    "granted_by" "uuid",
    "granted_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."compliance_report_grants" OWNER TO "postgres";

--
-- Name: compliance_volunteers; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."compliance_volunteers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "school_id" "uuid" NOT NULL,
    "first_name" "text" NOT NULL,
    "last_name" "text" NOT NULL,
    "email" "text",
    "guardian_id" "uuid",
    "match_key" "text" GENERATED ALWAYS AS ("public"."compliance_volunteer_match_key"("first_name", "last_name")) STORED,
    "volunteer_roles" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "bg_cleared_at" "date",
    "bg_expires_at" "date",
    "mvr_cleared_at" "date",
    "mvr_expires_at" "date",
    "dl_expires_at" "date",
    "insurance_expires_at" "date",
    "can_chaperone" boolean DEFAULT true NOT NULL,
    "can_drive" boolean DEFAULT true NOT NULL,
    "admin_note" "text",
    "archived_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."compliance_volunteers" OWNER TO "postgres";

--
-- Name: compliance_volunteer_status; Type: VIEW; Schema: public; Owner: postgres
--

CREATE OR REPLACE VIEW "public"."compliance_volunteer_status" WITH ("security_invoker"='true') AS
 SELECT "id",
    "school_id",
    "first_name",
    "last_name",
    "email",
    "guardian_id",
    "match_key",
    "volunteer_roles",
    "bg_cleared_at",
    "bg_expires_at",
    "mvr_cleared_at",
    "mvr_expires_at",
    "dl_expires_at",
    "insurance_expires_at",
    "can_chaperone",
    "can_drive",
    "admin_note",
    "archived_at",
    "created_at",
    "updated_at",
    (("bg_expires_at" IS NOT NULL) AND ("bg_expires_at" < CURRENT_DATE)) AS "bg_expired",
    (("mvr_expires_at" IS NOT NULL) AND ("mvr_expires_at" < CURRENT_DATE)) AS "mvr_expired",
    (("dl_expires_at" IS NOT NULL) AND ("dl_expires_at" < CURRENT_DATE)) AS "dl_expired",
    (("insurance_expires_at" IS NOT NULL) AND ("insurance_expires_at" < CURRENT_DATE)) AS "insurance_expired",
    LEAST("bg_expires_at", "mvr_expires_at", "dl_expires_at", "insurance_expires_at") AS "next_expiry",
        CASE
            WHEN ("bg_cleared_at" IS NULL) THEN 'missing_bg'::"text"
            WHEN (("bg_expires_at" IS NOT NULL) AND ("bg_expires_at" < CURRENT_DATE)) THEN 'expired'::"text"
            WHEN ((LEAST("bg_expires_at", "mvr_expires_at", "dl_expires_at", "insurance_expires_at") IS NOT NULL) AND (LEAST("bg_expires_at", "mvr_expires_at", "dl_expires_at", "insurance_expires_at") < CURRENT_DATE)) THEN 'expired'::"text"
            WHEN ((LEAST("bg_expires_at", "mvr_expires_at", "dl_expires_at", "insurance_expires_at") IS NOT NULL) AND (LEAST("bg_expires_at", "mvr_expires_at", "dl_expires_at", "insurance_expires_at") <= (CURRENT_DATE + 30))) THEN 'expiring_30'::"text"
            WHEN ((LEAST("bg_expires_at", "mvr_expires_at", "dl_expires_at", "insurance_expires_at") IS NOT NULL) AND (LEAST("bg_expires_at", "mvr_expires_at", "dl_expires_at", "insurance_expires_at") <= (CURRENT_DATE + 60))) THEN 'expiring_60'::"text"
            ELSE 'ok'::"text"
        END AS "worst_status"
   FROM "public"."compliance_volunteers" "v";


ALTER VIEW "public"."compliance_volunteer_status" OWNER TO "postgres";

--
-- Name: employee_pto_policies; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."employee_pto_policies" (
    "employee_id" "uuid" NOT NULL,
    "pto_type" "text" NOT NULL,
    "annual_hours" numeric(6,2) NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "annual_hours_non_negative" CHECK (("annual_hours" >= (0)::numeric)),
    CONSTRAINT "employee_pto_policies_annual_hours_check" CHECK (("annual_hours" >= (0)::numeric))
);


ALTER TABLE "public"."employee_pto_policies" OWNER TO "postgres";

--
-- Name: employees; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."employees" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "school_id" "uuid" NOT NULL,
    "user_id" "uuid",
    "first_name" "text" NOT NULL,
    "last_name" "text" NOT NULL,
    "email" "text",
    "position" "text",
    "active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "pto_allotment_month" integer DEFAULT 1,
    "supervisor_id" "uuid",
    "profile_id" "uuid",
    "employment_months" smallint,
    "campus_id" "uuid",
    "birthdate" "date",
    "is_teacher" boolean DEFAULT false NOT NULL,
    "staff_group_id" "uuid",
    "grade" "text"
);


ALTER TABLE "public"."employees" OWNER TO "postgres";

--
-- Name: COLUMN "employees"."grade"; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN "public"."employees"."grade" IS 'Optional explicit grade assignment for the employee''s homeroom (e.g. PK, K, 1-12). Matches students.grade_level short codes. When set, takes precedence over deriving the teacher''s grade from currently-enrolled students.';


--
-- Name: families; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."families" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "school_id" "uuid" NOT NULL,
    "family_name" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "active" boolean DEFAULT true NOT NULL,
    "carline_tag_number" "text" NOT NULL,
    "carline_tag_sort" integer GENERATED ALWAYS AS ((NULLIF("regexp_replace"("carline_tag_number", '[^0-9]'::"text", ''::"text", 'g'::"text"), ''::"text"))::integer) STORED,
    "skip_car_line" boolean DEFAULT false NOT NULL,
    "ec_needs" boolean DEFAULT false NOT NULL,
    "other_flag" boolean DEFAULT false NOT NULL,
    "other_flag_note" "text"
);


ALTER TABLE "public"."families" OWNER TO "postgres";

--
-- Name: COLUMN "families"."skip_car_line"; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN "public"."families"."skip_car_line" IS 'True if this family should skip the car line (special dismissal handling).';


--
-- Name: COLUMN "families"."ec_needs"; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN "public"."families"."ec_needs" IS 'True if this family has an EC (exceptional children) need flagged for staff awareness.';


--
-- Name: COLUMN "families"."other_flag"; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN "public"."families"."other_flag" IS 'True if this family has some other special-handling need; details in other_flag_note.';


--
-- Name: COLUMN "families"."other_flag_note"; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN "public"."families"."other_flag_note" IS 'Free-text detail for other_flag. Not meaningful unless other_flag is true.';


--
-- Name: field_trip_chaperones; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."field_trip_chaperones" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "school_id" "uuid" NOT NULL,
    "field_trip_id" "uuid" NOT NULL,
    "guardian_id" "uuid" NOT NULL,
    "is_driver" boolean DEFAULT false NOT NULL,
    "added_by_profile_id" "uuid",
    "added_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "removed_at" timestamp with time zone,
    "vehicle_capacity" integer
);


ALTER TABLE "public"."field_trip_chaperones" OWNER TO "postgres";

--
-- Name: field_trip_managers; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."field_trip_managers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "field_trip_id" "uuid" NOT NULL,
    "profile_id" "uuid" NOT NULL,
    "added_by" "uuid",
    "added_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."field_trip_managers" OWNER TO "postgres";

--
-- Name: field_trip_payment_log; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."field_trip_payment_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "payment_id" "uuid" NOT NULL,
    "amount" numeric(8,2) NOT NULL,
    "received_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "notes" "text",
    "recorded_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "field_trip_payment_log_amount_check" CHECK (("amount" > (0)::numeric))
);


ALTER TABLE "public"."field_trip_payment_log" OWNER TO "postgres";

--
-- Name: field_trip_payments; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."field_trip_payments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "school_id" "uuid" NOT NULL,
    "field_trip_id" "uuid" NOT NULL,
    "student_id" "uuid",
    "chaperone_id" "uuid",
    "payer_type" "text" NOT NULL,
    "amount_due" numeric(8,2) DEFAULT 0 NOT NULL,
    "amount_paid" numeric(8,2) DEFAULT 0 NOT NULL,
    "status" "text" DEFAULT 'unpaid'::"text" NOT NULL,
    "waive_reason" "text",
    "notes" "text",
    "last_payment_date" "date",
    "updated_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "field_trip_payments_one_payer" CHECK (((("student_id" IS NOT NULL) AND ("chaperone_id" IS NULL)) OR (("student_id" IS NULL) AND ("chaperone_id" IS NOT NULL)))),
    CONSTRAINT "field_trip_payments_payer_type_check" CHECK (("payer_type" = ANY (ARRAY['student'::"text", 'chaperone'::"text"]))),
    CONSTRAINT "field_trip_payments_status_check" CHECK (("status" = ANY (ARRAY['unpaid'::"text", 'partial'::"text", 'paid'::"text", 'waived'::"text"])))
);


ALTER TABLE "public"."field_trip_payments" OWNER TO "postgres";

--
-- Name: field_trip_students; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."field_trip_students" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "school_id" "uuid" NOT NULL,
    "field_trip_id" "uuid" NOT NULL,
    "student_id" "uuid" NOT NULL,
    "attending" boolean DEFAULT true NOT NULL
);


ALTER TABLE "public"."field_trip_students" OWNER TO "postgres";

--
-- Name: field_trip_vehicle_assignments; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."field_trip_vehicle_assignments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "school_id" "uuid" NOT NULL,
    "field_trip_id" "uuid" NOT NULL,
    "student_id" "uuid" NOT NULL,
    "chaperone_id" "uuid" NOT NULL,
    "assigned_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."field_trip_vehicle_assignments" OWNER TO "postgres";

--
-- Name: field_trips; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."field_trips" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "school_id" "uuid" NOT NULL,
    "campus_id" "uuid",
    "name" "text" NOT NULL,
    "destination" "text",
    "start_date" "date" NOT NULL,
    "depart_at" time without time zone,
    "return_at" time without time zone,
    "grade_levels" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "homeroom_teacher_ids" "uuid"[] DEFAULT '{}'::"uuid"[] NOT NULL,
    "drivers_needed" boolean DEFAULT false NOT NULL,
    "max_chaperones" integer,
    "notes" "text",
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "created_by_profile_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "end_date" "date",
    "payment_required" boolean DEFAULT false NOT NULL,
    "student_cost" numeric(8,2),
    "chaperone_payment_required" boolean DEFAULT false NOT NULL,
    "chaperone_cost" numeric(8,2),
    "allow_installments" boolean DEFAULT false NOT NULL,
    "installment_schedule" "jsonb",
    "payment_due_date" "date",
    CONSTRAINT "field_trips_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."field_trips" OWNER TO "postgres";

--
-- Name: grade_check; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."grade_check" (
    "first_name" "text",
    "last_name" "text",
    "intended_grade" "text"
);


ALTER TABLE "public"."grade_check" OWNER TO "postgres";

--
-- Name: guardian_intake_campaigns; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."guardian_intake_campaigns" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "school_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "token" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "closed_at" timestamp with time zone,
    "field_config" "jsonb" DEFAULT '{"email": true, "phone": true, "students": true, "relationship": true, "second_guardian": true}'::"jsonb" NOT NULL,
    CONSTRAINT "guardian_intake_campaigns_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'closed'::"text", 'archived'::"text"])))
);


ALTER TABLE "public"."guardian_intake_campaigns" OWNER TO "postgres";

--
-- Name: guardian_intake_submissions; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."guardian_intake_submissions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "campaign_id" "uuid" NOT NULL,
    "school_id" "uuid" NOT NULL,
    "submitted_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "first_name" "text" NOT NULL,
    "last_name" "text" NOT NULL,
    "email" "text",
    "phone_cell" "text",
    "relationship" "text",
    "ok_to_text" boolean DEFAULT false NOT NULL,
    "students" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "match_confidence" "text",
    "match_candidates" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "review_status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "matched_guardian_id" "uuid",
    "matched_family_id" "uuid",
    "merged_into_id" "uuid",
    "review_notes" "text",
    "reviewed_by" "uuid",
    "reviewed_at" timestamp with time zone,
    CONSTRAINT "guardian_intake_submissions_match_confidence_check" CHECK (("match_confidence" = ANY (ARRAY['high'::"text", 'medium'::"text", 'none'::"text"]))),
    CONSTRAINT "guardian_intake_submissions_review_status_check" CHECK (("review_status" = ANY (ARRAY['pending'::"text", 'accepted'::"text", 'partial'::"text", 'discarded'::"text", 'merged'::"text"])))
);


ALTER TABLE "public"."guardian_intake_submissions" OWNER TO "postgres";

--
-- Name: guardians; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."guardians" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "school_id" "uuid" NOT NULL,
    "family_id" "uuid" NOT NULL,
    "first_name" "text",
    "last_name" "text",
    "phone" "text",
    "email" "text",
    "active" boolean DEFAULT true NOT NULL,
    "is_primary_contact" boolean DEFAULT false,
    "dl_expires_at" "date",
    "insurance_expires_at" "date",
    "can_chaperone" boolean DEFAULT true NOT NULL,
    "can_drive" boolean DEFAULT true NOT NULL,
    "ic_sourced_id" "text",
    "last_synced_at" timestamp with time zone
);


ALTER TABLE "public"."guardians" OWNER TO "postgres";

--
-- Name: ic_data_gaps; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."ic_data_gaps" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "school_id" "uuid" NOT NULL,
    "entity_type" "text" NOT NULL,
    "entity_id" "uuid" NOT NULL,
    "ic_sourced_id" "text" NOT NULL,
    "field" "text" NOT NULL,
    "belltower_value" "text",
    "first_detected_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_detected_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "resolved_at" timestamp with time zone,
    CONSTRAINT "ic_data_gaps_entity_type_check" CHECK (("entity_type" = ANY (ARRAY['student'::"text", 'guardian'::"text"])))
);


ALTER TABLE "public"."ic_data_gaps" OWNER TO "postgres";

--
-- Name: ic_field_diffs; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."ic_field_diffs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "school_id" "uuid" NOT NULL,
    "entity_type" "text" NOT NULL,
    "entity_id" "uuid" NOT NULL,
    "ic_sourced_id" "text" NOT NULL,
    "field" "text" NOT NULL,
    "belltower_value" "text",
    "ic_value" "text",
    "first_detected_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_detected_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "resolved_at" timestamp with time zone,
    CONSTRAINT "ic_field_diffs_entity_type_check" CHECK (("entity_type" = ANY (ARRAY['student'::"text", 'guardian'::"text"])))
);


ALTER TABLE "public"."ic_field_diffs" OWNER TO "postgres";

--
-- Name: ic_reconciliation_candidates; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."ic_reconciliation_candidates" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "school_id" "uuid" NOT NULL,
    "entity_type" "text" NOT NULL,
    "ic_sourced_id" "text" NOT NULL,
    "existing_record_id" "uuid",
    "match_reason" "text" NOT NULL,
    "existing_data" "jsonb" NOT NULL,
    "proposed_data" "jsonb" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "reviewed_at" timestamp with time zone,
    "reviewed_by" "uuid",
    "field_overrides" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    CONSTRAINT "ic_reconciliation_candidates_entity_type_check" CHECK (("entity_type" = ANY (ARRAY['student'::"text", 'guardian'::"text", 'family'::"text"]))),
    CONSTRAINT "ic_reconciliation_candidates_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'approved'::"text", 'rejected'::"text"])))
);


ALTER TABLE "public"."ic_reconciliation_candidates" OWNER TO "postgres";

--
-- Name: ic_sync_field_settings; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."ic_sync_field_settings" (
    "school_id" "uuid" NOT NULL,
    "sync_grade_level" boolean DEFAULT false NOT NULL,
    "sync_date_of_birth" boolean DEFAULT false NOT NULL,
    "sync_student_number" boolean DEFAULT false NOT NULL,
    "sync_email" boolean DEFAULT false NOT NULL,
    "sync_phone" boolean DEFAULT false NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."ic_sync_field_settings" OWNER TO "postgres";

--
-- Name: ic_sync_runs; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."ic_sync_runs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "school_id" "uuid" NOT NULL,
    "started_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "finished_at" timestamp with time zone,
    "status" "text" DEFAULT 'running'::"text" NOT NULL,
    "students_created" integer DEFAULT 0 NOT NULL,
    "students_updated" integer DEFAULT 0 NOT NULL,
    "students_deactivated" integer DEFAULT 0 NOT NULL,
    "guardians_created" integer DEFAULT 0 NOT NULL,
    "guardians_updated" integer DEFAULT 0 NOT NULL,
    "families_created" integer DEFAULT 0 NOT NULL,
    "error_message" "text",
    "dry_run" boolean DEFAULT false NOT NULL,
    "preview_summary" "jsonb",
    "students_awaiting_review" integer DEFAULT 0 NOT NULL,
    "guardians_awaiting_review" integer DEFAULT 0 NOT NULL
);


ALTER TABLE "public"."ic_sync_runs" OWNER TO "postgres";

--
-- Name: inventory_assignments; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."inventory_assignments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "list_id" "uuid" NOT NULL,
    "student_id" "uuid" NOT NULL,
    "item_id" "uuid" NOT NULL,
    "identifier" "text",
    "status" "text" DEFAULT 'not_assigned'::"text" NOT NULL,
    "checked_out_at" timestamp with time zone,
    "returned_at" timestamp with time zone,
    "note" "text",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "inventory_assignments_status_check" CHECK (("status" = ANY (ARRAY['not_assigned'::"text", 'checked_out'::"text", 'returned'::"text"])))
);


ALTER TABLE "public"."inventory_assignments" OWNER TO "postgres";

--
-- Name: inventory_list_items; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."inventory_list_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "list_id" "uuid" NOT NULL,
    "label" "text" NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL
);


ALTER TABLE "public"."inventory_list_items" OWNER TO "postgres";

--
-- Name: inventory_list_members; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."inventory_list_members" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "list_id" "uuid" NOT NULL,
    "student_id" "uuid" NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL
);


ALTER TABLE "public"."inventory_list_members" OWNER TO "postgres";

--
-- Name: inventory_lists; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."inventory_lists" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "school_id" "uuid" NOT NULL,
    "owner_profile_id" "uuid",
    "owner_name" "text" NOT NULL,
    "name" "text" NOT NULL,
    "archived_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."inventory_lists" OWNER TO "postgres";

--
-- Name: license_alert_log; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."license_alert_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "school_id" "uuid" NOT NULL,
    "license_id" "uuid" NOT NULL,
    "employee_id" "uuid" NOT NULL,
    "alert_type" "text" NOT NULL,
    "sent_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."license_alert_log" OWNER TO "postgres";

--
-- Name: permission_audit_log; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."permission_audit_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "school_id" "uuid" NOT NULL,
    "target_profile_id" "uuid" NOT NULL,
    "changed_by_profile_id" "uuid",
    "field_name" "text" NOT NULL,
    "old_value" boolean,
    "new_value" boolean,
    "changed_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."permission_audit_log" OWNER TO "postgres";

--
-- Name: placement_assignments; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."placement_assignments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "session_id" "uuid" NOT NULL,
    "student_id" "uuid" NOT NULL,
    "teacher_id" "uuid",
    "sort_order" integer DEFAULT 0 NOT NULL,
    "prev_homeroom_teacher_id" "uuid",
    "assigned_col_id" "uuid",
    "manually_added" boolean DEFAULT false NOT NULL
);


ALTER TABLE "public"."placement_assignments" OWNER TO "postgres";

--
-- Name: placement_audit_log; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."placement_audit_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "session_id" "uuid" NOT NULL,
    "school_id" "uuid" NOT NULL,
    "student_id" "uuid" NOT NULL,
    "student_name" "text" NOT NULL,
    "from_teacher_id" "uuid",
    "from_teacher_name" "text",
    "to_teacher_id" "uuid",
    "to_teacher_name" "text",
    "changed_by_id" "uuid",
    "changed_by_name" "text",
    "changed_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."placement_audit_log" OWNER TO "postgres";

--
-- Name: placement_flags; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."placement_flags" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "school_id" "uuid" NOT NULL,
    "label" "text" NOT NULL,
    "color" "text" DEFAULT '#6366f1'::"text" NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "archived_at" timestamp with time zone
);


ALTER TABLE "public"."placement_flags" OWNER TO "postgres";

--
-- Name: placement_session_notes; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."placement_session_notes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "session_id" "uuid" NOT NULL,
    "author_id" "uuid",
    "author_name" "text" DEFAULT ''::"text" NOT NULL,
    "body" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."placement_session_notes" OWNER TO "postgres";

--
-- Name: placement_session_teachers; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."placement_session_teachers" (
    "session_id" "uuid" NOT NULL,
    "teacher_id" "uuid",
    "sort_order" integer DEFAULT 0 NOT NULL,
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "placeholder_name" "text",
    CONSTRAINT "placement_session_teachers_teacher_or_placeholder" CHECK ((("teacher_id" IS NOT NULL) OR ("placeholder_name" IS NOT NULL)))
);


ALTER TABLE "public"."placement_session_teachers" OWNER TO "postgres";

--
-- Name: placement_sessions; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."placement_sessions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "school_id" "uuid" NOT NULL,
    "academic_year" "text" NOT NULL,
    "incoming_grade" "text",
    "target_grade" "text",
    "label" "text" NOT NULL,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "committed_at" timestamp with time zone,
    "target_class_size" integer,
    "archived_at" timestamp with time zone,
    "deleted_at" timestamp with time zone,
    "sort_order" integer DEFAULT 0 NOT NULL
);


ALTER TABLE "public"."placement_sessions" OWNER TO "postgres";

--
-- Name: profiles; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "user_id" "uuid",
    "school_id" "uuid",
    "role" "text" NOT NULL,
    "display_name" "text",
    "email" "text",
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "is_superadmin" boolean DEFAULT false NOT NULL,
    "employee_id" "uuid",
    "can_view_carline" boolean DEFAULT false NOT NULL,
    "can_view_pto_calendar" boolean DEFAULT false NOT NULL,
    "can_review_pto" boolean DEFAULT false NOT NULL,
    "can_approve_pto" boolean DEFAULT false NOT NULL,
    "can_adjust_pto" boolean DEFAULT false NOT NULL,
    "can_bulk_upload" boolean DEFAULT false NOT NULL,
    "can_manage_guardians" boolean DEFAULT false NOT NULL,
    "can_login" boolean DEFAULT false NOT NULL,
    "can_access_admin" boolean DEFAULT false NOT NULL,
    "can_generate_pto_reports" boolean DEFAULT false NOT NULL,
    "can_manage_access" boolean DEFAULT false NOT NULL,
    "can_manage_staff" boolean DEFAULT false NOT NULL,
    "can_manage_families" boolean DEFAULT false NOT NULL,
    "can_manage_substitutes" boolean DEFAULT false NOT NULL,
    "can_manage_students" boolean DEFAULT false NOT NULL,
    "can_manage_bus_groups" boolean DEFAULT false NOT NULL,
    "can_export_data" boolean DEFAULT false NOT NULL,
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "is_fallback_approver" boolean DEFAULT false NOT NULL,
    "can_manage_carline" boolean DEFAULT false NOT NULL,
    "can_manage_campuses" boolean DEFAULT false,
    "can_manage_licensure" boolean DEFAULT false NOT NULL,
    "can_manage_carpools" boolean DEFAULT false NOT NULL,
    "active_school_id" "uuid",
    "last_sign_in_at" timestamp with time zone,
    "can_manage_placement" boolean DEFAULT false,
    "can_manage_compliance" boolean DEFAULT false NOT NULL,
    "can_manage_field_trips" boolean DEFAULT false NOT NULL,
    "can_manage_pto_balances" boolean DEFAULT false NOT NULL,
    "can_submit_on_behalf" boolean DEFAULT false NOT NULL,
    "can_manage_calendar" boolean DEFAULT false NOT NULL,
    "can_manage_resource_docs" boolean DEFAULT false NOT NULL,
    "can_manage_reservations" boolean DEFAULT false NOT NULL,
    "can_manage_inventory" boolean DEFAULT false NOT NULL,
    "can_manage_requests" boolean DEFAULT false NOT NULL,
    "can_view_students" boolean DEFAULT false NOT NULL,
    "can_view_families" boolean DEFAULT false NOT NULL
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";

--
-- Name: COLUMN "profiles"."can_manage_carpools"; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN "public"."profiles"."can_manage_carpools" IS 'Grants the Pickup Tags admin tab. Name predates the UI rename; do not change it -- permission_audit_log stores tracked permission names as text in historical rows.';


--
-- Name: COLUMN "profiles"."can_view_students"; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN "public"."profiles"."can_view_students" IS 'View-only access to the Students tab. Superseded by can_manage_students (full read-write) when that is also true.';


--
-- Name: COLUMN "profiles"."can_view_families"; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN "public"."profiles"."can_view_families" IS 'View-only access to the Families tab. Superseded by can_manage_families (full read-write) when that is also true.';


--
-- Name: pto_balances; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."pto_balances" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "school_id" "uuid" NOT NULL,
    "employee_id" "uuid" NOT NULL,
    "pto_type" "text" NOT NULL,
    "balance_hours" numeric(6,2) DEFAULT 0 NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."pto_balances" OWNER TO "postgres";

--
-- Name: pto_ledger; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."pto_ledger" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "school_id" "uuid" NOT NULL,
    "employee_id" "uuid" NOT NULL,
    "pto_type" "text" NOT NULL,
    "delta_hours" numeric(6,2) NOT NULL,
    "reason" "text" NOT NULL,
    "related_request_id" "uuid",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."pto_ledger" OWNER TO "postgres";

--
-- Name: pto_requests; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."pto_requests" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "school_id" "uuid" NOT NULL,
    "employee_id" "uuid" NOT NULL,
    "pto_type" "text" NOT NULL,
    "start_date" "date" NOT NULL,
    "end_date" "date" NOT NULL,
    "partial_day" boolean DEFAULT false NOT NULL,
    "partial_hours" numeric(4,2),
    "notes" "text",
    "status" "public"."pto_status" DEFAULT 'PENDING'::"public"."pto_status" NOT NULL,
    "submitted_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "decided_at" timestamp with time zone,
    "decided_by" "uuid",
    "start_time" time without time zone,
    "end_time" time without time zone,
    "requested_hours" numeric NOT NULL,
    "requested_duration_label" "text",
    "needs_sub_coverage" boolean DEFAULT false NOT NULL,
    "sub_coverage_notified_at" timestamp with time zone,
    "sub_coverage_notified_by" "uuid",
    "submitted_by" "uuid",
    CONSTRAINT "chk_dates_valid" CHECK (("end_date" >= "start_date"))
);


ALTER TABLE "public"."pto_requests" OWNER TO "postgres";

--
-- Name: request_categories; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."request_categories" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "school_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "is_active" boolean DEFAULT true NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "notify_managers" boolean DEFAULT true NOT NULL,
    "resolved_label" "text",
    "allow_denial" boolean DEFAULT false NOT NULL,
    "denied_label" "text",
    "is_restricted" boolean DEFAULT false NOT NULL,
    "allow_completed" boolean DEFAULT false NOT NULL
);


ALTER TABLE "public"."request_categories" OWNER TO "postgres";

--
-- Name: request_category_fields; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."request_category_fields" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "category_id" "uuid" NOT NULL,
    "label" "text" NOT NULL,
    "field_type" "text" NOT NULL,
    "options" "jsonb",
    "is_required" boolean DEFAULT false NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "request_category_fields_field_type_check" CHECK (("field_type" = ANY (ARRAY['text'::"text", 'textarea'::"text", 'select'::"text", 'date'::"text", 'boolean'::"text", 'file'::"text", 'routing'::"text", 'date_range'::"text", 'time'::"text", 'phone'::"text", 'currency'::"text", 'url'::"text"])))
);


ALTER TABLE "public"."request_category_fields" OWNER TO "postgres";

--
-- Name: request_category_managers; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."request_category_managers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "category_id" "uuid" NOT NULL,
    "profile_id" "uuid" NOT NULL,
    "added_by" "uuid",
    "added_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."request_category_managers" OWNER TO "postgres";

--
-- Name: request_category_visibility; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."request_category_visibility" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "category_id" "uuid" NOT NULL,
    "profile_id" "uuid" NOT NULL,
    "added_by" "uuid",
    "added_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."request_category_visibility" OWNER TO "postgres";

--
-- Name: reservable_resources; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."reservable_resources" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "school_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "color" "text" DEFAULT '#2563eb'::"text" NOT NULL,
    "requires_approval" boolean DEFAULT false NOT NULL,
    "active" boolean DEFAULT true NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "group_id" "uuid",
    "title_label" "text" DEFAULT 'Title'::"text" NOT NULL,
    "title_input_type" "text" DEFAULT 'text'::"text" NOT NULL,
    "title_max_value" integer,
    "policy_text" "text",
    "campus_id" "uuid",
    "use_time_blocks" boolean DEFAULT false NOT NULL,
    CONSTRAINT "reservable_resources_title_input_type_check" CHECK (("title_input_type" = ANY (ARRAY['text'::"text", 'number'::"text"])))
);


ALTER TABLE "public"."reservable_resources" OWNER TO "postgres";

--
-- Name: reservations; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."reservations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "school_id" "uuid" NOT NULL,
    "resource_id" "uuid" NOT NULL,
    "reserved_by_profile_id" "uuid",
    "reserved_by_name" "text" NOT NULL,
    "title" "text" NOT NULL,
    "notes" "text",
    "starts_at" timestamp with time zone NOT NULL,
    "ends_at" timestamp with time zone NOT NULL,
    "status" "text" DEFAULT 'confirmed'::"text" NOT NULL,
    "decided_by" "uuid",
    "decided_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "reservations_check" CHECK (("ends_at" > "starts_at")),
    CONSTRAINT "reservations_status_check" CHECK (("status" = ANY (ARRAY['confirmed'::"text", 'pending'::"text", 'denied'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."reservations" OWNER TO "postgres";

--
-- Name: resource_document_bookmarks; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."resource_document_bookmarks" (
    "profile_id" "uuid" NOT NULL,
    "document_id" "uuid" NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."resource_document_bookmarks" OWNER TO "postgres";

--
-- Name: resource_document_categories; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."resource_document_categories" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "school_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "color" "text",
    "sort_order" integer DEFAULT 0 NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."resource_document_categories" OWNER TO "postgres";

--
-- Name: resource_documents; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."resource_documents" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "school_id" "uuid" NOT NULL,
    "title" "text" NOT NULL,
    "file_path" "text" NOT NULL,
    "original_filename" "text",
    "uploaded_by" "uuid",
    "uploaded_by_name" "text",
    "sort_order" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "category_id" "uuid"
);


ALTER TABLE "public"."resource_documents" OWNER TO "postgres";

--
-- Name: resource_groups; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."resource_groups" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "school_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "color" "text" DEFAULT '#2563eb'::"text" NOT NULL,
    "requires_approval" boolean DEFAULT false NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "title_label" "text" DEFAULT 'Title'::"text" NOT NULL,
    "title_input_type" "text" DEFAULT 'text'::"text" NOT NULL,
    "title_max_value" integer,
    "policy_text" "text",
    "campus_id" "uuid",
    "use_time_blocks" boolean DEFAULT false NOT NULL,
    CONSTRAINT "resource_groups_title_input_type_check" CHECK (("title_input_type" = ANY (ARRAY['text'::"text", 'number'::"text"])))
);


ALTER TABLE "public"."resource_groups" OWNER TO "postgres";

--
-- Name: resource_time_blocks; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."resource_time_blocks" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "school_id" "uuid" NOT NULL,
    "campus_id" "uuid",
    "label" "text" NOT NULL,
    "start_time" time without time zone NOT NULL,
    "end_time" time without time zone NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "resource_time_blocks_check" CHECK (("end_time" > "start_time"))
);


ALTER TABLE "public"."resource_time_blocks" OWNER TO "postgres";

--
-- Name: school_calendar_events; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."school_calendar_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "school_id" "uuid" NOT NULL,
    "title" "text" NOT NULL,
    "event_date" "date" NOT NULL,
    "end_date" "date",
    "event_type" "text" DEFAULT 'no_school'::"text" NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "start_time" time without time zone,
    "end_time" time without time zone,
    "location" "text",
    CONSTRAINT "school_calendar_events_event_type_check" CHECK (("event_type" = ANY (ARRAY['no_school'::"text", 'holiday'::"text", 'pd_day'::"text", 'early_release'::"text", 'break'::"text", 'quarter_end'::"text", 'first_last_day'::"text", 'event'::"text"])))
);


ALTER TABLE "public"."school_calendar_events" OWNER TO "postgres";

--
-- Name: school_domains; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."school_domains" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "school_id" "uuid" NOT NULL,
    "domain" "text" NOT NULL
);


ALTER TABLE "public"."school_domains" OWNER TO "postgres";

--
-- Name: school_modules; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."school_modules" (
    "school_id" "uuid" NOT NULL,
    "module" "text" NOT NULL,
    "enabled" boolean DEFAULT false NOT NULL
);


ALTER TABLE "public"."school_modules" OWNER TO "postgres";

--
-- Name: school_pto_types; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."school_pto_types" (
    "school_id" "uuid" NOT NULL,
    "pto_type" "text" NOT NULL,
    "enabled" boolean DEFAULT true NOT NULL,
    "counts_against_balance" boolean DEFAULT true NOT NULL,
    "notes_required" boolean DEFAULT false NOT NULL,
    "sort_order" integer DEFAULT 99 NOT NULL
);


ALTER TABLE "public"."school_pto_types" OWNER TO "postgres";

--
-- Name: school_settings; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."school_settings" (
    "school_id" "uuid" NOT NULL,
    "workday_hours" numeric DEFAULT 8 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "rollover_max_hours" numeric DEFAULT 8 NOT NULL,
    "payout_max_hours" numeric DEFAULT 32 NOT NULL,
    "payout_eligible_months" integer[] DEFAULT '{10}'::integer[] NOT NULL,
    "pto_time_increment_minutes" integer DEFAULT 15,
    "day_start_time" time without time zone DEFAULT '07:20:00'::time without time zone,
    "day_end_time" time without time zone DEFAULT '15:45:00'::time without time zone,
    "carline_kiosk_pin" "text"
);


ALTER TABLE "public"."school_settings" OWNER TO "postgres";

--
-- Name: school_student_sequences; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."school_student_sequences" (
    "school_id" "uuid" NOT NULL,
    "next_number" integer DEFAULT 1 NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."school_student_sequences" OWNER TO "postgres";

--
-- Name: schools; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."schools" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "short_name" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "calendar_ics_token" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "email_domain" "text",
    "deletable" boolean DEFAULT false NOT NULL,
    "logo_url" "text",
    "grade_levels" "text"[] DEFAULT ARRAY['PK'::"text", 'K'::"text", '1'::"text", '2'::"text", '3'::"text", '4'::"text", '5'::"text", '6'::"text", '7'::"text", '8'::"text", '9'::"text", '10'::"text", '11'::"text", '12'::"text"],
    "terminal_grade" "text" DEFAULT '12'::"text",
    "uses_homerooms" boolean DEFAULT true,
    "require_mvr_for_drivers" boolean DEFAULT true,
    "pto_from_email" "text",
    "pto_reply_to" "text",
    "weather_lat" numeric,
    "weather_lon" numeric,
    "phone" "text",
    "address" "text",
    "city" "text",
    "state" "text",
    "zip" "text",
    "timezone" "text" DEFAULT 'America/New_York'::"text",
    "notifications_from_email" "text",
    "notifications_reply_to" "text",
    "calendar_pdf_url" "text"
);


ALTER TABLE "public"."schools" OWNER TO "postgres";

--
-- Name: COLUMN "schools"."notifications_from_email"; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN "public"."schools"."notifications_from_email" IS 'From address for general notifications (requests, alerts). Falls back to pto_from_email, then the system default.';


--
-- Name: COLUMN "schools"."notifications_reply_to"; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN "public"."schools"."notifications_reply_to" IS 'Reply-to for general notifications. Falls back to pto_reply_to, then the system default.';


--
-- Name: staff_groups; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."staff_groups" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "school_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "sort_order" integer DEFAULT 99 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."staff_groups" OWNER TO "postgres";

--
-- Name: staff_license_ceus; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."staff_license_ceus" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "school_id" "uuid" NOT NULL,
    "license_id" "uuid" NOT NULL,
    "employee_id" "uuid" NOT NULL,
    "category" "text" NOT NULL,
    "title" "text" NOT NULL,
    "provider" "text",
    "source_type" "text" DEFAULT 'lea_inservice'::"text" NOT NULL,
    "hours" numeric NOT NULL,
    "ceu_amount" numeric GENERATED ALWAYS AS (
CASE
    WHEN ("source_type" = 'college_credit'::"text") THEN ("hours" * 1.5)
    ELSE ("hours" / (10)::numeric)
END) STORED,
    "completed_date" "date" NOT NULL,
    "verified" boolean DEFAULT false NOT NULL,
    "verified_by" "uuid",
    "verified_at" timestamp with time zone,
    "file_path" "text",
    "file_name" "text",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "uuid",
    CONSTRAINT "staff_license_ceus_category_check" CHECK (("category" = ANY (ARRAY['literacy'::"text", 'content'::"text", 'digital_learning'::"text", 'administration'::"text", 'professional_discipline'::"text", 'general_other'::"text"]))),
    CONSTRAINT "staff_license_ceus_hours_check" CHECK (("hours" > (0)::numeric)),
    CONSTRAINT "staff_license_ceus_source_type_check" CHECK (("source_type" = ANY (ARRAY['college_credit'::"text", 'lea_inservice'::"text", 'lea_approved'::"text"])))
);


ALTER TABLE "public"."staff_license_ceus" OWNER TO "postgres";

--
-- Name: staff_license_files; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."staff_license_files" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "license_id" "uuid" NOT NULL,
    "school_id" "uuid" NOT NULL,
    "file_path" "text" NOT NULL,
    "file_name" "text" NOT NULL,
    "uploaded_by" "uuid",
    "uploaded_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "is_current" boolean DEFAULT true NOT NULL
);


ALTER TABLE "public"."staff_license_files" OWNER TO "postgres";

--
-- Name: staff_license_history; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."staff_license_history" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "license_id" "uuid" NOT NULL,
    "school_id" "uuid" NOT NULL,
    "changed_by" "uuid",
    "changed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "change_type" "text" NOT NULL,
    "field_changes" "jsonb"
);


ALTER TABLE "public"."staff_license_history" OWNER TO "postgres";

--
-- Name: staff_licenses; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."staff_licenses" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "school_id" "uuid" NOT NULL,
    "employee_id" "uuid" NOT NULL,
    "license_number" "text",
    "state" "text" DEFAULT 'NC'::"text" NOT NULL,
    "license_type" "text" NOT NULL,
    "category" "text" DEFAULT 'teaching'::"text" NOT NULL,
    "license_area" "text",
    "grade_authorization" "text",
    "issue_date" "date",
    "expiration_date" "date",
    "is_provisional" boolean DEFAULT false NOT NULL,
    "provisional_type" "text",
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "renewal_status" "text" DEFAULT 'not_started'::"text" NOT NULL,
    "campus_id" "uuid",
    "role_applicability" "text"[] DEFAULT '{}'::"text"[],
    "verified" boolean DEFAULT false NOT NULL,
    "verified_by" "uuid",
    "verified_at" timestamp with time zone,
    "alert_muted" boolean DEFAULT false NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "uuid",
    "license_class" "text"
);


ALTER TABLE "public"."staff_licenses" OWNER TO "postgres";

--
-- Name: staff_request_responses; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."staff_request_responses" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "request_id" "uuid" NOT NULL,
    "field_id" "uuid" NOT NULL,
    "value" "text"
);


ALTER TABLE "public"."staff_request_responses" OWNER TO "postgres";

--
-- Name: staff_requests; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."staff_requests" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "school_id" "uuid" NOT NULL,
    "category_id" "uuid" NOT NULL,
    "submitted_by" "uuid" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "manager_notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "assigned_manager_id" "uuid",
    CONSTRAINT "staff_requests_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'in_review'::"text", 'resolved'::"text", 'denied'::"text", 'completed'::"text"])))
);


ALTER TABLE "public"."staff_requests" OWNER TO "postgres";

--
-- Name: student_placement_flags; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."student_placement_flags" (
    "student_id" "uuid" NOT NULL,
    "flag_id" "uuid" NOT NULL
);


ALTER TABLE "public"."student_placement_flags" OWNER TO "postgres";

--
-- Name: student_promotion_log; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."student_promotion_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "school_id" "uuid" NOT NULL,
    "academic_year" "text" NOT NULL,
    "run_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "run_by" "uuid" NOT NULL,
    "promoted_count" integer DEFAULT 0 NOT NULL,
    "retained_count" integer DEFAULT 0 NOT NULL,
    "graduated_count" integer DEFAULT 0 NOT NULL,
    "snapshot" "jsonb"
);


ALTER TABLE "public"."student_promotion_log" OWNER TO "postgres";

--
-- Name: students; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."students" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "school_id" "uuid" NOT NULL,
    "family_id" "uuid",
    "student_number" "text",
    "first_name" "text" NOT NULL,
    "last_name" "text" NOT NULL,
    "grade_level" "text",
    "homeroom_teacher" "text",
    "bus_group_id" "uuid",
    "active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "homeroom_teacher_id" "uuid",
    "campus_id" "uuid",
    "graduation_year" integer,
    "retained" boolean DEFAULT false NOT NULL,
    "withdrawn_at" "date",
    "withdrawal_reason" "text",
    "is_retained" boolean DEFAULT false,
    "birthdate" "date",
    "preferred_name" "text",
    "grade_sort" integer GENERATED ALWAYS AS (
CASE
    WHEN ("grade_level" = 'PK'::"text") THEN '-2'::integer
    WHEN ("grade_level" = 'K'::"text") THEN '-1'::integer
    WHEN ("grade_level" ~ '^[0-9]+$'::"text") THEN ("grade_level")::integer
    ELSE NULL::integer
END) STORED,
    "ic_sourced_id" "text",
    "last_synced_at" timestamp with time zone
);


ALTER TABLE "public"."students" OWNER TO "postgres";

--
-- Name: substitute_assignments; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."substitute_assignments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "school_id" "uuid" NOT NULL,
    "substitute_id" "uuid",
    "employee_id" "uuid",
    "start_date" "date" NOT NULL,
    "end_date" "date" NOT NULL,
    "start_time" time without time zone,
    "end_time" time without time zone,
    "reason" "text",
    "status" "text" DEFAULT 'scheduled'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "pto_request_id" "uuid",
    "covered_employee_id" "uuid",
    CONSTRAINT "substitute_assignments_exactly_one_coverer" CHECK ((("substitute_id" IS NULL) <> ("employee_id" IS NULL))),
    CONSTRAINT "substitute_assignments_has_covered_target" CHECK ((("pto_request_id" IS NOT NULL) OR ("covered_employee_id" IS NOT NULL)))
);


ALTER TABLE "public"."substitute_assignments" OWNER TO "postgres";

--
-- Name: substitutes; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."substitutes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "school_id" "uuid" NOT NULL,
    "first_name" "text" NOT NULL,
    "last_name" "text" NOT NULL,
    "email" "text",
    "phone" "text",
    "notes" "text",
    "active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."substitutes" OWNER TO "postgres";

--
-- Name: supervisor_candidates; Type: VIEW; Schema: public; Owner: postgres
--

CREATE OR REPLACE VIEW "public"."supervisor_candidates" AS
 SELECT "e"."id",
    "e"."first_name",
    "e"."last_name",
    "e"."school_id"
   FROM ("public"."profiles" "p"
     JOIN "public"."employees" "e" ON (("e"."id" = "p"."employee_id")))
  WHERE (("p"."can_approve_pto" = true) AND ("e"."active" = true));


ALTER VIEW "public"."supervisor_candidates" OWNER TO "postgres";

--
-- Name: v_pending_cancellation_days; Type: VIEW; Schema: public; Owner: postgres
--

CREATE OR REPLACE VIEW "public"."v_pending_cancellation_days" AS
 SELECT "pr"."id" AS "pto_request_id",
    "pr"."school_id",
    "pr"."employee_id" AS "out_employee_id",
    "e"."first_name" AS "out_first_name",
    "e"."last_name" AS "out_last_name",
    "pr"."pto_type",
    "pr"."notes",
    "pr"."status",
    ("gs"."gs")::"date" AS "coverage_date",
    "sa"."id" AS "assignment_id",
    "sa"."substitute_id",
    "sa"."employee_id" AS "covering_employee_id",
    "sa"."start_time",
    "sa"."end_time",
    "sa"."reason",
    "sa"."status" AS "assignment_status"
   FROM ((("public"."pto_requests" "pr"
     JOIN "public"."employees" "e" ON (("e"."id" = "pr"."employee_id")))
     CROSS JOIN LATERAL "generate_series"(("pr"."start_date")::timestamp with time zone, ("pr"."end_date")::timestamp with time zone, '1 day'::interval) "gs"("gs"))
     JOIN "public"."substitute_assignments" "sa" ON ((("sa"."pto_request_id" = "pr"."id") AND ("sa"."start_date" = ("gs"."gs")::"date") AND ("sa"."end_date" = ("gs"."gs")::"date") AND ("sa"."status" = 'scheduled'::"text"))))
  WHERE (("pr"."needs_sub_coverage" = true) AND ("pr"."status" = ANY (ARRAY['CANCELLED'::"public"."pto_status", 'RESCINDED'::"public"."pto_status"])) AND (EXTRACT(dow FROM "gs"."gs") <> ALL (ARRAY[(0)::numeric, (6)::numeric])) AND (("gs"."gs")::"date" >= CURRENT_DATE));


ALTER VIEW "public"."v_pending_cancellation_days" OWNER TO "postgres";

--
-- Name: v_pto_coverage_days_approved; Type: VIEW; Schema: public; Owner: postgres
--

CREATE OR REPLACE VIEW "public"."v_pto_coverage_days_approved" AS
 SELECT "pr"."id" AS "pto_request_id",
    "pr"."school_id",
    "pr"."employee_id" AS "out_employee_id",
    "e"."first_name" AS "out_first_name",
    "e"."last_name" AS "out_last_name",
    "pr"."pto_type",
    "pr"."notes",
    "pr"."status",
    ("gs"."gs")::"date" AS "coverage_date",
        CASE
            WHEN (("pr"."start_date" = "pr"."end_date") AND ("pr"."partial_day" = true)) THEN "pr"."start_time"
            ELSE NULL::time without time zone
        END AS "start_time",
        CASE
            WHEN (("pr"."start_date" = "pr"."end_date") AND ("pr"."partial_day" = true)) THEN "pr"."end_time"
            ELSE NULL::time without time zone
        END AS "end_time"
   FROM (("public"."pto_requests" "pr"
     JOIN "public"."employees" "e" ON (("e"."id" = "pr"."employee_id")))
     CROSS JOIN LATERAL "generate_series"(("pr"."start_date")::timestamp with time zone, ("pr"."end_date")::timestamp with time zone, '1 day'::interval) "gs"("gs"))
  WHERE (("pr"."needs_sub_coverage" = true) AND ("pr"."status" = 'APPROVED'::"public"."pto_status") AND (EXTRACT(dow FROM "gs"."gs") <> ALL (ARRAY[(0)::numeric, (6)::numeric])));


ALTER VIEW "public"."v_pto_coverage_days_approved" OWNER TO "postgres";

--
-- Name: v_pending_coverage_days; Type: VIEW; Schema: public; Owner: postgres
--

CREATE OR REPLACE VIEW "public"."v_pending_coverage_days" AS
 SELECT "v"."pto_request_id",
    "v"."school_id",
    "v"."out_employee_id",
    "v"."out_first_name",
    "v"."out_last_name",
    "v"."pto_type",
    "v"."notes",
    "v"."status",
    "v"."coverage_date",
    "v"."start_time",
    "v"."end_time",
    "sa"."id" AS "assignment_id"
   FROM ("public"."v_pto_coverage_days_approved" "v"
     LEFT JOIN "public"."substitute_assignments" "sa" ON ((("sa"."pto_request_id" = "v"."pto_request_id") AND ("sa"."start_date" = "v"."coverage_date") AND ("sa"."end_date" = "v"."coverage_date") AND ("sa"."status" = 'scheduled'::"text"))))
  WHERE (("sa"."id" IS NULL) AND ("v"."coverage_date" >= CURRENT_DATE));


ALTER VIEW "public"."v_pending_coverage_days" OWNER TO "postgres";

--
-- Name: access_requests access_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."access_requests"
    ADD CONSTRAINT "access_requests_pkey" PRIMARY KEY ("id");


--
-- Name: bulk_upload_logs bulk_upload_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."bulk_upload_logs"
    ADD CONSTRAINT "bulk_upload_logs_pkey" PRIMARY KEY ("id");


--
-- Name: bus_groups bus_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."bus_groups"
    ADD CONSTRAINT "bus_groups_pkey" PRIMARY KEY ("id");


--
-- Name: campuses campuses_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."campuses"
    ADD CONSTRAINT "campuses_pkey" PRIMARY KEY ("id");


--
-- Name: carline_bus_arrivals carline_bus_arrivals_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."carline_bus_arrivals"
    ADD CONSTRAINT "carline_bus_arrivals_pkey" PRIMARY KEY ("id");


--
-- Name: carline_calls carline_calls_event_student_unique; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."carline_calls"
    ADD CONSTRAINT "carline_calls_event_student_unique" UNIQUE ("carline_event_id", "student_id");


--
-- Name: carline_calls carline_calls_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."carline_calls"
    ADD CONSTRAINT "carline_calls_pkey" PRIMARY KEY ("id");


--
-- Name: carline_events carline_events_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."carline_events"
    ADD CONSTRAINT "carline_events_pkey" PRIMARY KEY ("id");


--
-- Name: carline_pickup_groups carline_pickup_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."carline_pickup_groups"
    ADD CONSTRAINT "carline_pickup_groups_pkey" PRIMARY KEY ("id");


--
-- Name: carline_tags carline_tags_carpool_family_unique; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."carline_tags"
    ADD CONSTRAINT "carline_tags_carpool_family_unique" UNIQUE ("carpool_id", "family_id");


--
-- Name: carline_tags carline_tags_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."carline_tags"
    ADD CONSTRAINT "carline_tags_pkey" PRIMARY KEY ("id");


--
-- Name: carpool_students carpool_students_carpool_student_unique; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."carpool_students"
    ADD CONSTRAINT "carpool_students_carpool_student_unique" UNIQUE ("carpool_id", "student_id");


--
-- Name: carpool_students carpool_students_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."carpool_students"
    ADD CONSTRAINT "carpool_students_pkey" PRIMARY KEY ("id");


--
-- Name: carpools carpools_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."carpools"
    ADD CONSTRAINT "carpools_pkey" PRIMARY KEY ("id");


--
-- Name: carpools carpools_school_tag_unique; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."carpools"
    ADD CONSTRAINT "carpools_school_tag_unique" UNIQUE ("school_id", "tag_number");


--
-- Name: compliance_agreements compliance_agreements_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."compliance_agreements"
    ADD CONSTRAINT "compliance_agreements_pkey" PRIMARY KEY ("id");


--
-- Name: compliance_bg_check_requests compliance_bg_check_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."compliance_bg_check_requests"
    ADD CONSTRAINT "compliance_bg_check_requests_pkey" PRIMARY KEY ("id");


--
-- Name: compliance_form_links compliance_form_links_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."compliance_form_links"
    ADD CONSTRAINT "compliance_form_links_pkey" PRIMARY KEY ("id");


--
-- Name: compliance_form_links compliance_form_links_token_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."compliance_form_links"
    ADD CONSTRAINT "compliance_form_links_token_key" UNIQUE ("token");


--
-- Name: compliance_form_templates compliance_form_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."compliance_form_templates"
    ADD CONSTRAINT "compliance_form_templates_pkey" PRIMARY KEY ("id");


--
-- Name: compliance_report_grants compliance_report_grants_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."compliance_report_grants"
    ADD CONSTRAINT "compliance_report_grants_pkey" PRIMARY KEY ("id");


--
-- Name: compliance_report_grants compliance_report_grants_school_id_grantee_id_teacher_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."compliance_report_grants"
    ADD CONSTRAINT "compliance_report_grants_school_id_grantee_id_teacher_id_key" UNIQUE ("school_id", "grantee_id", "teacher_id");


--
-- Name: compliance_volunteers compliance_volunteers_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."compliance_volunteers"
    ADD CONSTRAINT "compliance_volunteers_pkey" PRIMARY KEY ("id");


--
-- Name: employee_pto_policies employee_pto_policies_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."employee_pto_policies"
    ADD CONSTRAINT "employee_pto_policies_pkey" PRIMARY KEY ("employee_id", "pto_type");


--
-- Name: employees employees_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."employees"
    ADD CONSTRAINT "employees_pkey" PRIMARY KEY ("id");


--
-- Name: families families_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."families"
    ADD CONSTRAINT "families_pkey" PRIMARY KEY ("id");


--
-- Name: field_trip_chaperones field_trip_chaperones_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."field_trip_chaperones"
    ADD CONSTRAINT "field_trip_chaperones_pkey" PRIMARY KEY ("id");


--
-- Name: field_trip_managers field_trip_managers_field_trip_id_profile_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."field_trip_managers"
    ADD CONSTRAINT "field_trip_managers_field_trip_id_profile_id_key" UNIQUE ("field_trip_id", "profile_id");


--
-- Name: field_trip_managers field_trip_managers_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."field_trip_managers"
    ADD CONSTRAINT "field_trip_managers_pkey" PRIMARY KEY ("id");


--
-- Name: field_trip_payment_log field_trip_payment_log_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."field_trip_payment_log"
    ADD CONSTRAINT "field_trip_payment_log_pkey" PRIMARY KEY ("id");


--
-- Name: field_trip_payments field_trip_payments_chaperone_unique; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."field_trip_payments"
    ADD CONSTRAINT "field_trip_payments_chaperone_unique" UNIQUE ("field_trip_id", "chaperone_id");


--
-- Name: field_trip_payments field_trip_payments_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."field_trip_payments"
    ADD CONSTRAINT "field_trip_payments_pkey" PRIMARY KEY ("id");


--
-- Name: field_trip_payments field_trip_payments_student_unique; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."field_trip_payments"
    ADD CONSTRAINT "field_trip_payments_student_unique" UNIQUE ("field_trip_id", "student_id");


--
-- Name: field_trip_students field_trip_students_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."field_trip_students"
    ADD CONSTRAINT "field_trip_students_pkey" PRIMARY KEY ("id");


--
-- Name: field_trip_vehicle_assignments field_trip_vehicle_assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."field_trip_vehicle_assignments"
    ADD CONSTRAINT "field_trip_vehicle_assignments_pkey" PRIMARY KEY ("id");


--
-- Name: field_trips field_trips_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."field_trips"
    ADD CONSTRAINT "field_trips_pkey" PRIMARY KEY ("id");


--
-- Name: field_trip_vehicle_assignments ftva_student_unique; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."field_trip_vehicle_assignments"
    ADD CONSTRAINT "ftva_student_unique" UNIQUE ("field_trip_id", "student_id");


--
-- Name: guardian_intake_campaigns guardian_intake_campaigns_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."guardian_intake_campaigns"
    ADD CONSTRAINT "guardian_intake_campaigns_pkey" PRIMARY KEY ("id");


--
-- Name: guardian_intake_campaigns guardian_intake_campaigns_token_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."guardian_intake_campaigns"
    ADD CONSTRAINT "guardian_intake_campaigns_token_key" UNIQUE ("token");


--
-- Name: guardian_intake_submissions guardian_intake_submissions_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."guardian_intake_submissions"
    ADD CONSTRAINT "guardian_intake_submissions_pkey" PRIMARY KEY ("id");


--
-- Name: guardians guardians_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."guardians"
    ADD CONSTRAINT "guardians_pkey" PRIMARY KEY ("id");


--
-- Name: guardians guardians_unique_per_family; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."guardians"
    ADD CONSTRAINT "guardians_unique_per_family" UNIQUE ("family_id", "first_name", "last_name", "email");


--
-- Name: ic_data_gaps ic_data_gaps_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."ic_data_gaps"
    ADD CONSTRAINT "ic_data_gaps_pkey" PRIMARY KEY ("id");


--
-- Name: ic_field_diffs ic_field_diffs_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."ic_field_diffs"
    ADD CONSTRAINT "ic_field_diffs_pkey" PRIMARY KEY ("id");


--
-- Name: ic_reconciliation_candidates ic_reconciliation_candidates_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."ic_reconciliation_candidates"
    ADD CONSTRAINT "ic_reconciliation_candidates_pkey" PRIMARY KEY ("id");


--
-- Name: ic_sync_field_settings ic_sync_field_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."ic_sync_field_settings"
    ADD CONSTRAINT "ic_sync_field_settings_pkey" PRIMARY KEY ("school_id");


--
-- Name: ic_sync_runs ic_sync_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."ic_sync_runs"
    ADD CONSTRAINT "ic_sync_runs_pkey" PRIMARY KEY ("id");


--
-- Name: inventory_assignments inventory_assignments_list_id_student_id_item_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."inventory_assignments"
    ADD CONSTRAINT "inventory_assignments_list_id_student_id_item_id_key" UNIQUE ("list_id", "student_id", "item_id");


--
-- Name: inventory_assignments inventory_assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."inventory_assignments"
    ADD CONSTRAINT "inventory_assignments_pkey" PRIMARY KEY ("id");


--
-- Name: inventory_list_items inventory_list_items_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."inventory_list_items"
    ADD CONSTRAINT "inventory_list_items_pkey" PRIMARY KEY ("id");


--
-- Name: inventory_list_members inventory_list_members_list_id_student_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."inventory_list_members"
    ADD CONSTRAINT "inventory_list_members_list_id_student_id_key" UNIQUE ("list_id", "student_id");


--
-- Name: inventory_list_members inventory_list_members_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."inventory_list_members"
    ADD CONSTRAINT "inventory_list_members_pkey" PRIMARY KEY ("id");


--
-- Name: inventory_lists inventory_lists_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."inventory_lists"
    ADD CONSTRAINT "inventory_lists_pkey" PRIMARY KEY ("id");


--
-- Name: license_alert_log license_alert_log_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."license_alert_log"
    ADD CONSTRAINT "license_alert_log_pkey" PRIMARY KEY ("id");


--
-- Name: permission_audit_log permission_audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."permission_audit_log"
    ADD CONSTRAINT "permission_audit_log_pkey" PRIMARY KEY ("id");


--
-- Name: placement_assignments placement_assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."placement_assignments"
    ADD CONSTRAINT "placement_assignments_pkey" PRIMARY KEY ("id");


--
-- Name: placement_assignments placement_assignments_session_student_unique; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."placement_assignments"
    ADD CONSTRAINT "placement_assignments_session_student_unique" UNIQUE ("session_id", "student_id");


--
-- Name: placement_audit_log placement_audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."placement_audit_log"
    ADD CONSTRAINT "placement_audit_log_pkey" PRIMARY KEY ("id");


--
-- Name: placement_flags placement_flags_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."placement_flags"
    ADD CONSTRAINT "placement_flags_pkey" PRIMARY KEY ("id");


--
-- Name: placement_session_notes placement_session_notes_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."placement_session_notes"
    ADD CONSTRAINT "placement_session_notes_pkey" PRIMARY KEY ("id");


--
-- Name: placement_session_teachers placement_session_teachers_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."placement_session_teachers"
    ADD CONSTRAINT "placement_session_teachers_pkey" PRIMARY KEY ("id");


--
-- Name: placement_sessions placement_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."placement_sessions"
    ADD CONSTRAINT "placement_sessions_pkey" PRIMARY KEY ("id");


--
-- Name: profiles profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");


--
-- Name: profiles profiles_unique_email; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_unique_email" UNIQUE ("email");


--
-- Name: pto_balances pto_balances_employee_type_unique; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."pto_balances"
    ADD CONSTRAINT "pto_balances_employee_type_unique" UNIQUE ("employee_id", "pto_type");


--
-- Name: pto_balances pto_balances_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."pto_balances"
    ADD CONSTRAINT "pto_balances_pkey" PRIMARY KEY ("id");


--
-- Name: pto_ledger pto_ledger_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."pto_ledger"
    ADD CONSTRAINT "pto_ledger_pkey" PRIMARY KEY ("id");


--
-- Name: pto_requests pto_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."pto_requests"
    ADD CONSTRAINT "pto_requests_pkey" PRIMARY KEY ("id");


--
-- Name: request_categories request_categories_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."request_categories"
    ADD CONSTRAINT "request_categories_pkey" PRIMARY KEY ("id");


--
-- Name: request_category_fields request_category_fields_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."request_category_fields"
    ADD CONSTRAINT "request_category_fields_pkey" PRIMARY KEY ("id");


--
-- Name: request_category_managers request_category_managers_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."request_category_managers"
    ADD CONSTRAINT "request_category_managers_pkey" PRIMARY KEY ("id");


--
-- Name: request_category_managers request_category_managers_unique; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."request_category_managers"
    ADD CONSTRAINT "request_category_managers_unique" UNIQUE ("category_id", "profile_id");


--
-- Name: request_category_visibility request_category_visibility_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."request_category_visibility"
    ADD CONSTRAINT "request_category_visibility_pkey" PRIMARY KEY ("id");


--
-- Name: request_category_visibility request_category_visibility_unique; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."request_category_visibility"
    ADD CONSTRAINT "request_category_visibility_unique" UNIQUE ("category_id", "profile_id");


--
-- Name: reservable_resources reservable_resources_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."reservable_resources"
    ADD CONSTRAINT "reservable_resources_pkey" PRIMARY KEY ("id");


--
-- Name: reservations reservations_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."reservations"
    ADD CONSTRAINT "reservations_pkey" PRIMARY KEY ("id");


--
-- Name: resource_document_bookmarks resource_document_bookmarks_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."resource_document_bookmarks"
    ADD CONSTRAINT "resource_document_bookmarks_pkey" PRIMARY KEY ("profile_id", "document_id");


--
-- Name: resource_document_categories resource_document_categories_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."resource_document_categories"
    ADD CONSTRAINT "resource_document_categories_pkey" PRIMARY KEY ("id");


--
-- Name: resource_documents resource_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."resource_documents"
    ADD CONSTRAINT "resource_documents_pkey" PRIMARY KEY ("id");


--
-- Name: resource_groups resource_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."resource_groups"
    ADD CONSTRAINT "resource_groups_pkey" PRIMARY KEY ("id");


--
-- Name: resource_time_blocks resource_time_blocks_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."resource_time_blocks"
    ADD CONSTRAINT "resource_time_blocks_pkey" PRIMARY KEY ("id");


--
-- Name: school_calendar_events school_calendar_events_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."school_calendar_events"
    ADD CONSTRAINT "school_calendar_events_pkey" PRIMARY KEY ("id");


--
-- Name: school_domains school_domains_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."school_domains"
    ADD CONSTRAINT "school_domains_pkey" PRIMARY KEY ("id");


--
-- Name: school_modules school_modules_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."school_modules"
    ADD CONSTRAINT "school_modules_pkey" PRIMARY KEY ("school_id", "module");


--
-- Name: school_pto_types school_pto_types_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."school_pto_types"
    ADD CONSTRAINT "school_pto_types_pkey" PRIMARY KEY ("school_id", "pto_type");


--
-- Name: school_settings school_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."school_settings"
    ADD CONSTRAINT "school_settings_pkey" PRIMARY KEY ("school_id");


--
-- Name: school_student_sequences school_student_sequences_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."school_student_sequences"
    ADD CONSTRAINT "school_student_sequences_pkey" PRIMARY KEY ("school_id");


--
-- Name: schools schools_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."schools"
    ADD CONSTRAINT "schools_pkey" PRIMARY KEY ("id");


--
-- Name: staff_groups staff_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."staff_groups"
    ADD CONSTRAINT "staff_groups_pkey" PRIMARY KEY ("id");


--
-- Name: staff_license_ceus staff_license_ceus_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."staff_license_ceus"
    ADD CONSTRAINT "staff_license_ceus_pkey" PRIMARY KEY ("id");


--
-- Name: staff_license_files staff_license_files_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."staff_license_files"
    ADD CONSTRAINT "staff_license_files_pkey" PRIMARY KEY ("id");


--
-- Name: staff_license_history staff_license_history_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."staff_license_history"
    ADD CONSTRAINT "staff_license_history_pkey" PRIMARY KEY ("id");


--
-- Name: staff_licenses staff_licenses_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."staff_licenses"
    ADD CONSTRAINT "staff_licenses_pkey" PRIMARY KEY ("id");


--
-- Name: staff_request_responses staff_request_responses_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."staff_request_responses"
    ADD CONSTRAINT "staff_request_responses_pkey" PRIMARY KEY ("id");


--
-- Name: staff_request_responses staff_request_responses_unique; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."staff_request_responses"
    ADD CONSTRAINT "staff_request_responses_unique" UNIQUE ("request_id", "field_id");


--
-- Name: staff_requests staff_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."staff_requests"
    ADD CONSTRAINT "staff_requests_pkey" PRIMARY KEY ("id");


--
-- Name: student_placement_flags student_placement_flags_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."student_placement_flags"
    ADD CONSTRAINT "student_placement_flags_pkey" PRIMARY KEY ("student_id", "flag_id");


--
-- Name: student_promotion_log student_promotion_log_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."student_promotion_log"
    ADD CONSTRAINT "student_promotion_log_pkey" PRIMARY KEY ("id");


--
-- Name: students students_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."students"
    ADD CONSTRAINT "students_pkey" PRIMARY KEY ("id");


--
-- Name: substitute_assignments substitute_assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."substitute_assignments"
    ADD CONSTRAINT "substitute_assignments_pkey" PRIMARY KEY ("id");


--
-- Name: substitutes substitutes_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."substitutes"
    ADD CONSTRAINT "substitutes_pkey" PRIMARY KEY ("id");


--
-- Name: pto_balances uq_balance_per_emp_type; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."pto_balances"
    ADD CONSTRAINT "uq_balance_per_emp_type" UNIQUE ("employee_id", "pto_type");


--
-- Name: employees uq_employee_email_per_school; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."employees"
    ADD CONSTRAINT "uq_employee_email_per_school" UNIQUE ("school_id", "email");


--
-- Name: school_domains uq_school_domain; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."school_domains"
    ADD CONSTRAINT "uq_school_domain" UNIQUE ("domain");


--
-- Name: students uq_student_number_per_school; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."students"
    ADD CONSTRAINT "uq_student_number_per_school" UNIQUE ("school_id", "student_number");


--
-- Name: bus_groups_school_id_name_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX "bus_groups_school_id_name_idx" ON "public"."bus_groups" USING "btree" ("school_id", "name");


--
-- Name: carline_bus_arrivals_event_recalled_called_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "carline_bus_arrivals_event_recalled_called_idx" ON "public"."carline_bus_arrivals" USING "btree" ("carline_event_id", "recalled_at", "called_at");


--
-- Name: carline_calls_event_status_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "carline_calls_event_status_idx" ON "public"."carline_calls" USING "btree" ("carline_event_id", "status");


--
-- Name: carline_calls_family_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "carline_calls_family_idx" ON "public"."carline_calls" USING "btree" ("family_id");


--
-- Name: carline_calls_school_id_event_id_status_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "carline_calls_school_id_event_id_status_idx" ON "public"."carline_calls" USING "btree" ("school_id", "carline_event_id", "status");


--
-- Name: carline_calls_student_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "carline_calls_student_idx" ON "public"."carline_calls" USING "btree" ("student_id");


--
-- Name: carline_events_school_campus_date_uq; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX "carline_events_school_campus_date_uq" ON "public"."carline_events" USING "btree" ("school_id", "event_date", "campus_id") NULLS NOT DISTINCT;


--
-- Name: carline_events_school_date_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "carline_events_school_date_idx" ON "public"."carline_events" USING "btree" ("school_id", "event_date");


--
-- Name: carline_events_school_id_event_date_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "carline_events_school_id_event_date_idx" ON "public"."carline_events" USING "btree" ("school_id", "event_date");


--
-- Name: carpool_students_student_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "carpool_students_student_id_idx" ON "public"."carpool_students" USING "btree" ("student_id");


--
-- Name: families_school_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "families_school_id_idx" ON "public"."families" USING "btree" ("school_id");


--
-- Name: families_school_tag_unique; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX "families_school_tag_unique" ON "public"."families" USING "btree" ("school_id", "carline_tag_number");


--
-- Name: field_trip_chaperones_active_unique; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX "field_trip_chaperones_active_unique" ON "public"."field_trip_chaperones" USING "btree" ("field_trip_id", "guardian_id") WHERE ("removed_at" IS NULL);


--
-- Name: field_trip_students_unique; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX "field_trip_students_unique" ON "public"."field_trip_students" USING "btree" ("field_trip_id", "student_id");


--
-- Name: guardians_school_ic_sourced_id_unique; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX "guardians_school_ic_sourced_id_unique" ON "public"."guardians" USING "btree" ("school_id", "ic_sourced_id") WHERE ("ic_sourced_id" IS NOT NULL);


--
-- Name: guardians_school_id_family_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "guardians_school_id_family_id_idx" ON "public"."guardians" USING "btree" ("school_id", "family_id");


--
-- Name: ic_data_gaps_unique; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX "ic_data_gaps_unique" ON "public"."ic_data_gaps" USING "btree" ("school_id", "entity_type", "entity_id", "field");


--
-- Name: ic_field_diffs_unique; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX "ic_field_diffs_unique" ON "public"."ic_field_diffs" USING "btree" ("school_id", "entity_type", "entity_id", "field");


--
-- Name: ic_reconciliation_candidates_unique; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX "ic_reconciliation_candidates_unique" ON "public"."ic_reconciliation_candidates" USING "btree" ("school_id", "entity_type", "ic_sourced_id") WHERE ("status" = 'pending'::"text");


--
-- Name: idx_bg_check_requests_requestor; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_bg_check_requests_requestor" ON "public"."compliance_bg_check_requests" USING "btree" ("requestor_id");


--
-- Name: idx_bg_check_requests_school; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_bg_check_requests_school" ON "public"."compliance_bg_check_requests" USING "btree" ("school_id", "status");


--
-- Name: idx_cal_events_school_date; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_cal_events_school_date" ON "public"."school_calendar_events" USING "btree" ("school_id", "event_date");


--
-- Name: idx_compliance_agreements_family; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_compliance_agreements_family" ON "public"."compliance_agreements" USING "btree" ("family_id");


--
-- Name: idx_compliance_agreements_guardian; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_compliance_agreements_guardian" ON "public"."compliance_agreements" USING "btree" ("guardian_id", "template_id");


--
-- Name: idx_compliance_agreements_link_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_compliance_agreements_link_status" ON "public"."compliance_agreements" USING "btree" ("school_id", "link_status");


--
-- Name: idx_compliance_agreements_review_pending; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_compliance_agreements_review_pending" ON "public"."compliance_agreements" USING "btree" ("school_id", "submitted_data_reviewed") WHERE (("submitted_data_reviewed" = false) AND (("submitted_phone" IS NOT NULL) OR ("submitted_relationship" IS NOT NULL)));


--
-- Name: idx_compliance_agreements_school_email; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_compliance_agreements_school_email" ON "public"."compliance_agreements" USING "btree" ("school_id", "signer_email");


--
-- Name: idx_compliance_agreements_template; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_compliance_agreements_template" ON "public"."compliance_agreements" USING "btree" ("template_id", "signed_at");


--
-- Name: idx_compliance_bg_check_requests_guardian; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_compliance_bg_check_requests_guardian" ON "public"."compliance_bg_check_requests" USING "btree" ("guardian_id");


--
-- Name: idx_compliance_bg_check_requests_volunteer; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_compliance_bg_check_requests_volunteer" ON "public"."compliance_bg_check_requests" USING "btree" ("volunteer_id");


--
-- Name: idx_compliance_form_links_token; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_compliance_form_links_token" ON "public"."compliance_form_links" USING "btree" ("token");


--
-- Name: idx_compliance_report_grants_grantee; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_compliance_report_grants_grantee" ON "public"."compliance_report_grants" USING "btree" ("school_id", "grantee_id");


--
-- Name: idx_compliance_report_grants_teacher; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_compliance_report_grants_teacher" ON "public"."compliance_report_grants" USING "btree" ("school_id", "teacher_id");


--
-- Name: idx_compliance_volunteers_guardian; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_compliance_volunteers_guardian" ON "public"."compliance_volunteers" USING "btree" ("guardian_id");


--
-- Name: idx_compliance_volunteers_school; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_compliance_volunteers_school" ON "public"."compliance_volunteers" USING "btree" ("school_id") WHERE ("archived_at" IS NULL);


--
-- Name: idx_employees_email_lower; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_employees_email_lower" ON "public"."employees" USING "btree" ("lower"("email"));


--
-- Name: idx_employees_school_active; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_employees_school_active" ON "public"."employees" USING "btree" ("school_id", "active");


--
-- Name: idx_field_trips_school_date; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_field_trips_school_date" ON "public"."field_trips" USING "btree" ("school_id", "start_date" DESC);


--
-- Name: idx_inventory_assignments_list; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_inventory_assignments_list" ON "public"."inventory_assignments" USING "btree" ("list_id");


--
-- Name: idx_inventory_list_items_list; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_inventory_list_items_list" ON "public"."inventory_list_items" USING "btree" ("list_id", "sort_order");


--
-- Name: idx_inventory_list_members_list; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_inventory_list_members_list" ON "public"."inventory_list_members" USING "btree" ("list_id");


--
-- Name: idx_inventory_lists_owner; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_inventory_lists_owner" ON "public"."inventory_lists" USING "btree" ("owner_profile_id");


--
-- Name: idx_inventory_lists_school; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_inventory_lists_school" ON "public"."inventory_lists" USING "btree" ("school_id");


--
-- Name: idx_license_alert_log; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_license_alert_log" ON "public"."license_alert_log" USING "btree" ("license_id", "alert_type", "sent_at");


--
-- Name: idx_license_files_license_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_license_files_license_id" ON "public"."staff_license_files" USING "btree" ("license_id");


--
-- Name: idx_license_history_license_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_license_history_license_id" ON "public"."staff_license_history" USING "btree" ("license_id");


--
-- Name: idx_placement_audit_log_session; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_placement_audit_log_session" ON "public"."placement_audit_log" USING "btree" ("session_id", "changed_at" DESC);


--
-- Name: idx_placement_notes_session; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_placement_notes_session" ON "public"."placement_session_notes" USING "btree" ("session_id", "created_at");


--
-- Name: idx_reservable_resources_campus; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_reservable_resources_campus" ON "public"."reservable_resources" USING "btree" ("campus_id");


--
-- Name: idx_reservable_resources_group; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_reservable_resources_group" ON "public"."reservable_resources" USING "btree" ("group_id");


--
-- Name: idx_reservable_resources_school; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_reservable_resources_school" ON "public"."reservable_resources" USING "btree" ("school_id", "sort_order");


--
-- Name: idx_reservations_resource_time; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_reservations_resource_time" ON "public"."reservations" USING "btree" ("resource_id", "starts_at", "ends_at");


--
-- Name: idx_reservations_school; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_reservations_school" ON "public"."reservations" USING "btree" ("school_id");


--
-- Name: idx_resource_doc_bookmarks_document; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_resource_doc_bookmarks_document" ON "public"."resource_document_bookmarks" USING "btree" ("document_id");


--
-- Name: idx_resource_doc_categories_school; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_resource_doc_categories_school" ON "public"."resource_document_categories" USING "btree" ("school_id", "sort_order");


--
-- Name: idx_resource_doc_categories_school_name; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX "idx_resource_doc_categories_school_name" ON "public"."resource_document_categories" USING "btree" ("school_id", "lower"("name"));


--
-- Name: idx_resource_documents_category; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_resource_documents_category" ON "public"."resource_documents" USING "btree" ("category_id");


--
-- Name: idx_resource_documents_school; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_resource_documents_school" ON "public"."resource_documents" USING "btree" ("school_id", "sort_order");


--
-- Name: idx_resource_groups_campus; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_resource_groups_campus" ON "public"."resource_groups" USING "btree" ("campus_id");


--
-- Name: idx_resource_groups_school; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_resource_groups_school" ON "public"."resource_groups" USING "btree" ("school_id", "sort_order");


--
-- Name: idx_resource_time_blocks_campus; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_resource_time_blocks_campus" ON "public"."resource_time_blocks" USING "btree" ("campus_id");


--
-- Name: idx_resource_time_blocks_school; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_resource_time_blocks_school" ON "public"."resource_time_blocks" USING "btree" ("school_id", "sort_order");


--
-- Name: idx_staff_license_ceus_employee_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_staff_license_ceus_employee_id" ON "public"."staff_license_ceus" USING "btree" ("employee_id");


--
-- Name: idx_staff_license_ceus_license_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_staff_license_ceus_license_id" ON "public"."staff_license_ceus" USING "btree" ("license_id");


--
-- Name: idx_staff_license_ceus_school_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_staff_license_ceus_school_id" ON "public"."staff_license_ceus" USING "btree" ("school_id");


--
-- Name: idx_staff_licenses_employee_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_staff_licenses_employee_id" ON "public"."staff_licenses" USING "btree" ("employee_id");


--
-- Name: idx_staff_licenses_expiration; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_staff_licenses_expiration" ON "public"."staff_licenses" USING "btree" ("school_id", "expiration_date");


--
-- Name: idx_staff_licenses_school_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_staff_licenses_school_id" ON "public"."staff_licenses" USING "btree" ("school_id");


--
-- Name: idx_students_grade_level; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_students_grade_level" ON "public"."students" USING "btree" ("school_id", "grade_level");


--
-- Name: idx_students_school_active; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_students_school_active" ON "public"."students" USING "btree" ("school_id", "active");


--
-- Name: idx_sub_assign_pto_request_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_sub_assign_pto_request_id" ON "public"."substitute_assignments" USING "btree" ("pto_request_id");


--
-- Name: idx_sub_assign_school_date; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_sub_assign_school_date" ON "public"."substitute_assignments" USING "btree" ("school_id", "start_date");


--
-- Name: intake_campaigns_school_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "intake_campaigns_school_id_idx" ON "public"."guardian_intake_campaigns" USING "btree" ("school_id");


--
-- Name: intake_campaigns_token_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "intake_campaigns_token_idx" ON "public"."guardian_intake_campaigns" USING "btree" ("token");


--
-- Name: intake_submissions_campaign_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "intake_submissions_campaign_idx" ON "public"."guardian_intake_submissions" USING "btree" ("campaign_id");


--
-- Name: intake_submissions_confidence_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "intake_submissions_confidence_idx" ON "public"."guardian_intake_submissions" USING "btree" ("match_confidence");


--
-- Name: intake_submissions_school_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "intake_submissions_school_idx" ON "public"."guardian_intake_submissions" USING "btree" ("school_id");


--
-- Name: intake_submissions_status_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "intake_submissions_status_idx" ON "public"."guardian_intake_submissions" USING "btree" ("review_status");


--
-- Name: permission_audit_log_school_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "permission_audit_log_school_idx" ON "public"."permission_audit_log" USING "btree" ("school_id", "changed_at" DESC);


--
-- Name: permission_audit_log_target_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "permission_audit_log_target_idx" ON "public"."permission_audit_log" USING "btree" ("target_profile_id", "changed_at" DESC);


--
-- Name: placement_session_teachers_session_teacher_uniq; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX "placement_session_teachers_session_teacher_uniq" ON "public"."placement_session_teachers" USING "btree" ("session_id", "teacher_id") WHERE ("teacher_id" IS NOT NULL);


--
-- Name: profiles_id_unique; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX "profiles_id_unique" ON "public"."profiles" USING "btree" ("id");


--
-- Name: profiles_role_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "profiles_role_idx" ON "public"."profiles" USING "btree" ("role");


--
-- Name: profiles_school_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "profiles_school_id_idx" ON "public"."profiles" USING "btree" ("school_id");


--
-- Name: profiles_unique_user_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX "profiles_unique_user_id" ON "public"."profiles" USING "btree" ("user_id") WHERE ("user_id" IS NOT NULL);


--
-- Name: pto_balances_school_id_employee_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "pto_balances_school_id_employee_id_idx" ON "public"."pto_balances" USING "btree" ("school_id", "employee_id");


--
-- Name: pto_ledger_school_id_employee_id_created_at_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "pto_ledger_school_id_employee_id_created_at_idx" ON "public"."pto_ledger" USING "btree" ("school_id", "employee_id", "created_at");


--
-- Name: pto_requests_school_id_employee_id_status_start_date_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "pto_requests_school_id_employee_id_status_start_date_idx" ON "public"."pto_requests" USING "btree" ("school_id", "employee_id", "status", "start_date");


--
-- Name: request_categories_school_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "request_categories_school_id_idx" ON "public"."request_categories" USING "btree" ("school_id");


--
-- Name: request_category_fields_category_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "request_category_fields_category_id_idx" ON "public"."request_category_fields" USING "btree" ("category_id");


--
-- Name: request_category_managers_category_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "request_category_managers_category_id_idx" ON "public"."request_category_managers" USING "btree" ("category_id");


--
-- Name: request_category_managers_profile_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "request_category_managers_profile_id_idx" ON "public"."request_category_managers" USING "btree" ("profile_id");


--
-- Name: request_category_visibility_category_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "request_category_visibility_category_id_idx" ON "public"."request_category_visibility" USING "btree" ("category_id");


--
-- Name: request_category_visibility_profile_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "request_category_visibility_profile_id_idx" ON "public"."request_category_visibility" USING "btree" ("profile_id");


--
-- Name: staff_request_responses_request_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "staff_request_responses_request_id_idx" ON "public"."staff_request_responses" USING "btree" ("request_id");


--
-- Name: staff_requests_category_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "staff_requests_category_id_idx" ON "public"."staff_requests" USING "btree" ("category_id");


--
-- Name: staff_requests_school_id_created_at_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "staff_requests_school_id_created_at_idx" ON "public"."staff_requests" USING "btree" ("school_id", "created_at" DESC);


--
-- Name: staff_requests_submitted_by_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "staff_requests_submitted_by_idx" ON "public"."staff_requests" USING "btree" ("submitted_by");


--
-- Name: students_family_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "students_family_id_idx" ON "public"."students" USING "btree" ("family_id");


--
-- Name: students_school_ic_sourced_id_unique; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX "students_school_ic_sourced_id_unique" ON "public"."students" USING "btree" ("school_id", "ic_sourced_id") WHERE ("ic_sourced_id" IS NOT NULL);


--
-- Name: students_school_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "students_school_id_idx" ON "public"."students" USING "btree" ("school_id");


--
-- Name: students_unique_identity; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX "students_unique_identity" ON "public"."students" USING "btree" ("school_id", "family_id", "lower"("first_name"), "lower"("last_name"));


--
-- Name: students_unique_per_school; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX "students_unique_per_school" ON "public"."students" USING "btree" ("school_id", "student_number");


--
-- Name: uniq_pto_annual_allotment; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX "uniq_pto_annual_allotment" ON "public"."pto_ledger" USING "btree" ("employee_id", "pto_type", "reason") WHERE ("reason" ~~ 'ANNUAL_ALLOTMENT_%'::"text");


--
-- Name: uq_compliance_volunteers_match_key; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX "uq_compliance_volunteers_match_key" ON "public"."compliance_volunteers" USING "btree" ("school_id", "match_key") WHERE ("archived_at" IS NULL);


--
-- Name: uq_license_alert_daily; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX "uq_license_alert_daily" ON "public"."license_alert_log" USING "btree" ("license_id", "alert_type", ((("sent_at" AT TIME ZONE 'America/New_York'::"text"))::"date"));


--
-- Name: uq_sub_assign_pto_day; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX "uq_sub_assign_pto_day" ON "public"."substitute_assignments" USING "btree" ("pto_request_id", "start_date") WHERE (("pto_request_id" IS NOT NULL) AND ("status" = 'scheduled'::"text"));


--
-- Name: employees before_employee_delete_placement_columns; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE OR REPLACE TRIGGER "before_employee_delete_placement_columns" BEFORE DELETE ON "public"."employees" FOR EACH ROW EXECUTE FUNCTION "public"."convert_placement_teacher_to_placeholder"();


--
-- Name: students before_insert_assign_student_number; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE OR REPLACE TRIGGER "before_insert_assign_student_number" BEFORE INSERT ON "public"."students" FOR EACH ROW EXECUTE FUNCTION "public"."assign_student_number"();


--
-- Name: carpool_students carpool_students_same_school; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE OR REPLACE TRIGGER "carpool_students_same_school" BEFORE INSERT OR UPDATE ON "public"."carpool_students" FOR EACH ROW EXECUTE FUNCTION "public"."assert_carpool_student_same_school"();


--
-- Name: carpools carpools_tag_free; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE OR REPLACE TRIGGER "carpools_tag_free" BEFORE INSERT OR UPDATE ON "public"."carpools" FOR EACH ROW EXECUTE FUNCTION "public"."assert_carpool_tag_free"();


--
-- Name: employees employees_supervisor_pto_check; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE OR REPLACE TRIGGER "employees_supervisor_pto_check" BEFORE INSERT OR UPDATE OF "supervisor_id" ON "public"."employees" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_supervisor_is_pto_approver"();


--
-- Name: families families_tag_free; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE OR REPLACE TRIGGER "families_tag_free" BEFORE INSERT OR UPDATE ON "public"."families" FOR EACH ROW EXECUTE FUNCTION "public"."assert_family_tag_free"();


--
-- Name: guardian_intake_submissions intake_submission_match; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE OR REPLACE TRIGGER "intake_submission_match" BEFORE INSERT ON "public"."guardian_intake_submissions" FOR EACH ROW EXECUTE FUNCTION "public"."compute_intake_match"();


--
-- Name: profiles profiles_fallback_approver_check; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE OR REPLACE TRIGGER "profiles_fallback_approver_check" BEFORE INSERT OR UPDATE OF "is_fallback_approver", "can_approve_pto" ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_fallback_approver_has_pto_access"();


--
-- Name: pto_requests pto_notification_trigger; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE OR REPLACE TRIGGER "pto_notification_trigger" AFTER INSERT OR UPDATE OF "status" ON "public"."pto_requests" FOR EACH ROW EXECUTE FUNCTION "public"."notify_pto_event"();


--
-- Name: schools schools_delete_guard; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE OR REPLACE TRIGGER "schools_delete_guard" BEFORE DELETE ON "public"."schools" FOR EACH ROW EXECUTE FUNCTION "public"."prevent_school_delete"();


--
-- Name: compliance_volunteers trg_compliance_volunteers_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE OR REPLACE TRIGGER "trg_compliance_volunteers_updated_at" BEFORE UPDATE ON "public"."compliance_volunteers" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();


--
-- Name: reservations trg_enforce_reservation_insert_status; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE OR REPLACE TRIGGER "trg_enforce_reservation_insert_status" BEFORE INSERT ON "public"."reservations" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_reservation_insert_status"();


--
-- Name: reservations trg_enforce_reservation_owner_update; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE OR REPLACE TRIGGER "trg_enforce_reservation_owner_update" BEFORE UPDATE ON "public"."reservations" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_reservation_owner_update"();


--
-- Name: profiles trg_log_permission_changes; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE OR REPLACE TRIGGER "trg_log_permission_changes" AFTER UPDATE ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."log_permission_changes"();


--
-- Name: pto_ledger trg_pto_ledger_insert; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE OR REPLACE TRIGGER "trg_pto_ledger_insert" AFTER INSERT ON "public"."pto_ledger" FOR EACH ROW EXECUTE FUNCTION "public"."handle_pto_ledger_insert"();


--
-- Name: pto_requests trg_pto_status_change; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE OR REPLACE TRIGGER "trg_pto_status_change" AFTER UPDATE ON "public"."pto_requests" FOR EACH ROW EXECUTE FUNCTION "public"."handle_pto_status_change"();


--
-- Name: staff_license_ceus trg_staff_license_ceus_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE OR REPLACE TRIGGER "trg_staff_license_ceus_updated_at" BEFORE UPDATE ON "public"."staff_license_ceus" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();


--
-- Name: staff_licenses trg_staff_licenses_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE OR REPLACE TRIGGER "trg_staff_licenses_updated_at" BEFORE UPDATE ON "public"."staff_licenses" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();


--
-- Name: access_requests access_requests_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."access_requests"
    ADD CONSTRAINT "access_requests_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id");


--
-- Name: bus_groups bus_groups_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."bus_groups"
    ADD CONSTRAINT "bus_groups_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE CASCADE;


--
-- Name: campuses campuses_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."campuses"
    ADD CONSTRAINT "campuses_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE CASCADE;


--
-- Name: carline_bus_arrivals carline_bus_arrivals_bus_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."carline_bus_arrivals"
    ADD CONSTRAINT "carline_bus_arrivals_bus_group_id_fkey" FOREIGN KEY ("bus_group_id") REFERENCES "public"."bus_groups"("id");


--
-- Name: carline_bus_arrivals carline_bus_arrivals_called_by_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."carline_bus_arrivals"
    ADD CONSTRAINT "carline_bus_arrivals_called_by_profile_id_fkey" FOREIGN KEY ("called_by_profile_id") REFERENCES "public"."profiles"("id");


--
-- Name: carline_bus_arrivals carline_bus_arrivals_carline_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."carline_bus_arrivals"
    ADD CONSTRAINT "carline_bus_arrivals_carline_event_id_fkey" FOREIGN KEY ("carline_event_id") REFERENCES "public"."carline_events"("id");


--
-- Name: carline_bus_arrivals carline_bus_arrivals_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."carline_bus_arrivals"
    ADD CONSTRAINT "carline_bus_arrivals_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id");


--
-- Name: carline_calls carline_calls_called_by_profile_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."carline_calls"
    ADD CONSTRAINT "carline_calls_called_by_profile_fkey" FOREIGN KEY ("called_by_profile_id") REFERENCES "public"."profiles"("id");


--
-- Name: carline_calls carline_calls_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."carline_calls"
    ADD CONSTRAINT "carline_calls_event_id_fkey" FOREIGN KEY ("carline_event_id") REFERENCES "public"."carline_events"("id") ON DELETE CASCADE;


--
-- Name: carline_calls carline_calls_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."carline_calls"
    ADD CONSTRAINT "carline_calls_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE SET NULL;


--
-- Name: carline_calls carline_calls_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."carline_calls"
    ADD CONSTRAINT "carline_calls_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE CASCADE;


--
-- Name: carline_calls carline_calls_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."carline_calls"
    ADD CONSTRAINT "carline_calls_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE CASCADE;


--
-- Name: carline_events carline_events_campus_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."carline_events"
    ADD CONSTRAINT "carline_events_campus_id_fkey" FOREIGN KEY ("campus_id") REFERENCES "public"."campuses"("id") ON DELETE SET NULL;


--
-- Name: carline_events carline_events_closed_by_profile_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."carline_events"
    ADD CONSTRAINT "carline_events_closed_by_profile_fkey" FOREIGN KEY ("closed_by_profile_id") REFERENCES "public"."profiles"("id");


--
-- Name: carline_events carline_events_created_by_profile_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."carline_events"
    ADD CONSTRAINT "carline_events_created_by_profile_fkey" FOREIGN KEY ("created_by_profile_id") REFERENCES "public"."profiles"("id");


--
-- Name: carline_events carline_events_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."carline_events"
    ADD CONSTRAINT "carline_events_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE CASCADE;


--
-- Name: carline_pickup_groups carline_pickup_groups_campus_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."carline_pickup_groups"
    ADD CONSTRAINT "carline_pickup_groups_campus_fkey" FOREIGN KEY ("campus_id") REFERENCES "public"."campuses"("id") ON DELETE SET NULL;


--
-- Name: carline_pickup_groups carline_pickup_groups_school_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."carline_pickup_groups"
    ADD CONSTRAINT "carline_pickup_groups_school_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE CASCADE;


--
-- Name: carline_tags carline_tags_carpool_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."carline_tags"
    ADD CONSTRAINT "carline_tags_carpool_id_fkey" FOREIGN KEY ("carpool_id") REFERENCES "public"."carpools"("id") ON DELETE CASCADE;


--
-- Name: carline_tags carline_tags_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."carline_tags"
    ADD CONSTRAINT "carline_tags_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE CASCADE;


--
-- Name: carpool_students carpool_students_carpool_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."carpool_students"
    ADD CONSTRAINT "carpool_students_carpool_id_fkey" FOREIGN KEY ("carpool_id") REFERENCES "public"."carpools"("id") ON DELETE CASCADE;


--
-- Name: carpool_students carpool_students_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."carpool_students"
    ADD CONSTRAINT "carpool_students_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE CASCADE;


--
-- Name: carpools carpools_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."carpools"
    ADD CONSTRAINT "carpools_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id");


--
-- Name: compliance_agreements compliance_agreements_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."compliance_agreements"
    ADD CONSTRAINT "compliance_agreements_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE SET NULL;


--
-- Name: compliance_agreements compliance_agreements_form_link_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."compliance_agreements"
    ADD CONSTRAINT "compliance_agreements_form_link_id_fkey" FOREIGN KEY ("form_link_id") REFERENCES "public"."compliance_form_links"("id");


--
-- Name: compliance_agreements compliance_agreements_guardian_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."compliance_agreements"
    ADD CONSTRAINT "compliance_agreements_guardian_id_fkey" FOREIGN KEY ("guardian_id") REFERENCES "public"."guardians"("id") ON DELETE SET NULL;


--
-- Name: compliance_agreements compliance_agreements_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."compliance_agreements"
    ADD CONSTRAINT "compliance_agreements_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE CASCADE;


--
-- Name: compliance_agreements compliance_agreements_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."compliance_agreements"
    ADD CONSTRAINT "compliance_agreements_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "public"."compliance_form_templates"("id");


--
-- Name: compliance_agreements compliance_agreements_voided_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."compliance_agreements"
    ADD CONSTRAINT "compliance_agreements_voided_by_fkey" FOREIGN KEY ("voided_by") REFERENCES "public"."profiles"("id");


--
-- Name: compliance_bg_check_requests compliance_bg_check_requests_guardian_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."compliance_bg_check_requests"
    ADD CONSTRAINT "compliance_bg_check_requests_guardian_id_fkey" FOREIGN KEY ("guardian_id") REFERENCES "public"."guardians"("id") ON DELETE SET NULL;


--
-- Name: compliance_bg_check_requests compliance_bg_check_requests_requestor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."compliance_bg_check_requests"
    ADD CONSTRAINT "compliance_bg_check_requests_requestor_id_fkey" FOREIGN KEY ("requestor_id") REFERENCES "public"."profiles"("id");


--
-- Name: compliance_bg_check_requests compliance_bg_check_requests_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."compliance_bg_check_requests"
    ADD CONSTRAINT "compliance_bg_check_requests_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE CASCADE;


--
-- Name: compliance_bg_check_requests compliance_bg_check_requests_volunteer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."compliance_bg_check_requests"
    ADD CONSTRAINT "compliance_bg_check_requests_volunteer_id_fkey" FOREIGN KEY ("volunteer_id") REFERENCES "public"."compliance_volunteers"("id") ON DELETE SET NULL;


--
-- Name: compliance_form_links compliance_form_links_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."compliance_form_links"
    ADD CONSTRAINT "compliance_form_links_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id");


--
-- Name: compliance_form_links compliance_form_links_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."compliance_form_links"
    ADD CONSTRAINT "compliance_form_links_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE CASCADE;


--
-- Name: compliance_form_links compliance_form_links_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."compliance_form_links"
    ADD CONSTRAINT "compliance_form_links_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "public"."compliance_form_templates"("id") ON DELETE CASCADE;


--
-- Name: compliance_form_templates compliance_form_templates_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."compliance_form_templates"
    ADD CONSTRAINT "compliance_form_templates_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id");


--
-- Name: compliance_form_templates compliance_form_templates_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."compliance_form_templates"
    ADD CONSTRAINT "compliance_form_templates_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE CASCADE;


--
-- Name: compliance_report_grants compliance_report_grants_granted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."compliance_report_grants"
    ADD CONSTRAINT "compliance_report_grants_granted_by_fkey" FOREIGN KEY ("granted_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;


--
-- Name: compliance_report_grants compliance_report_grants_grantee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."compliance_report_grants"
    ADD CONSTRAINT "compliance_report_grants_grantee_id_fkey" FOREIGN KEY ("grantee_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;


--
-- Name: compliance_report_grants compliance_report_grants_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."compliance_report_grants"
    ADD CONSTRAINT "compliance_report_grants_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE CASCADE;


--
-- Name: compliance_report_grants compliance_report_grants_teacher_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."compliance_report_grants"
    ADD CONSTRAINT "compliance_report_grants_teacher_id_fkey" FOREIGN KEY ("teacher_id") REFERENCES "public"."employees"("id") ON DELETE CASCADE;


--
-- Name: compliance_volunteers compliance_volunteers_guardian_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."compliance_volunteers"
    ADD CONSTRAINT "compliance_volunteers_guardian_id_fkey" FOREIGN KEY ("guardian_id") REFERENCES "public"."guardians"("id") ON DELETE SET NULL;


--
-- Name: compliance_volunteers compliance_volunteers_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."compliance_volunteers"
    ADD CONSTRAINT "compliance_volunteers_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE CASCADE;


--
-- Name: employee_pto_policies employee_pto_policies_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."employee_pto_policies"
    ADD CONSTRAINT "employee_pto_policies_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE CASCADE;


--
-- Name: employees employees_campus_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."employees"
    ADD CONSTRAINT "employees_campus_id_fkey" FOREIGN KEY ("campus_id") REFERENCES "public"."campuses"("id") ON DELETE SET NULL;


--
-- Name: employees employees_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."employees"
    ADD CONSTRAINT "employees_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id");


--
-- Name: employees employees_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."employees"
    ADD CONSTRAINT "employees_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE CASCADE;


--
-- Name: employees employees_staff_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."employees"
    ADD CONSTRAINT "employees_staff_group_id_fkey" FOREIGN KEY ("staff_group_id") REFERENCES "public"."staff_groups"("id") ON DELETE SET NULL;


--
-- Name: employees employees_supervisor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."employees"
    ADD CONSTRAINT "employees_supervisor_id_fkey" FOREIGN KEY ("supervisor_id") REFERENCES "public"."employees"("id");


--
-- Name: families families_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."families"
    ADD CONSTRAINT "families_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE CASCADE;


--
-- Name: field_trip_chaperones field_trip_chaperones_added_by_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."field_trip_chaperones"
    ADD CONSTRAINT "field_trip_chaperones_added_by_profile_id_fkey" FOREIGN KEY ("added_by_profile_id") REFERENCES "public"."profiles"("id");


--
-- Name: field_trip_chaperones field_trip_chaperones_field_trip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."field_trip_chaperones"
    ADD CONSTRAINT "field_trip_chaperones_field_trip_id_fkey" FOREIGN KEY ("field_trip_id") REFERENCES "public"."field_trips"("id") ON DELETE CASCADE;


--
-- Name: field_trip_chaperones field_trip_chaperones_guardian_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."field_trip_chaperones"
    ADD CONSTRAINT "field_trip_chaperones_guardian_id_fkey" FOREIGN KEY ("guardian_id") REFERENCES "public"."guardians"("id") ON DELETE CASCADE;


--
-- Name: field_trip_chaperones field_trip_chaperones_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."field_trip_chaperones"
    ADD CONSTRAINT "field_trip_chaperones_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE CASCADE;


--
-- Name: field_trip_managers field_trip_managers_added_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."field_trip_managers"
    ADD CONSTRAINT "field_trip_managers_added_by_fkey" FOREIGN KEY ("added_by") REFERENCES "public"."profiles"("id");


--
-- Name: field_trip_managers field_trip_managers_field_trip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."field_trip_managers"
    ADD CONSTRAINT "field_trip_managers_field_trip_id_fkey" FOREIGN KEY ("field_trip_id") REFERENCES "public"."field_trips"("id") ON DELETE CASCADE;


--
-- Name: field_trip_managers field_trip_managers_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."field_trip_managers"
    ADD CONSTRAINT "field_trip_managers_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;


--
-- Name: field_trip_payment_log field_trip_payment_log_payment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."field_trip_payment_log"
    ADD CONSTRAINT "field_trip_payment_log_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "public"."field_trip_payments"("id") ON DELETE CASCADE;


--
-- Name: field_trip_payment_log field_trip_payment_log_recorded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."field_trip_payment_log"
    ADD CONSTRAINT "field_trip_payment_log_recorded_by_fkey" FOREIGN KEY ("recorded_by") REFERENCES "public"."profiles"("id");


--
-- Name: field_trip_payments field_trip_payments_chaperone_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."field_trip_payments"
    ADD CONSTRAINT "field_trip_payments_chaperone_id_fkey" FOREIGN KEY ("chaperone_id") REFERENCES "public"."field_trip_chaperones"("id") ON DELETE CASCADE;


--
-- Name: field_trip_payments field_trip_payments_field_trip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."field_trip_payments"
    ADD CONSTRAINT "field_trip_payments_field_trip_id_fkey" FOREIGN KEY ("field_trip_id") REFERENCES "public"."field_trips"("id") ON DELETE CASCADE;


--
-- Name: field_trip_payments field_trip_payments_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."field_trip_payments"
    ADD CONSTRAINT "field_trip_payments_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE CASCADE;


--
-- Name: field_trip_payments field_trip_payments_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."field_trip_payments"
    ADD CONSTRAINT "field_trip_payments_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE CASCADE;


--
-- Name: field_trip_payments field_trip_payments_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."field_trip_payments"
    ADD CONSTRAINT "field_trip_payments_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."profiles"("id");


--
-- Name: field_trip_students field_trip_students_field_trip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."field_trip_students"
    ADD CONSTRAINT "field_trip_students_field_trip_id_fkey" FOREIGN KEY ("field_trip_id") REFERENCES "public"."field_trips"("id") ON DELETE CASCADE;


--
-- Name: field_trip_students field_trip_students_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."field_trip_students"
    ADD CONSTRAINT "field_trip_students_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE CASCADE;


--
-- Name: field_trip_students field_trip_students_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."field_trip_students"
    ADD CONSTRAINT "field_trip_students_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE CASCADE;


--
-- Name: field_trip_vehicle_assignments field_trip_vehicle_assignments_assigned_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."field_trip_vehicle_assignments"
    ADD CONSTRAINT "field_trip_vehicle_assignments_assigned_by_fkey" FOREIGN KEY ("assigned_by") REFERENCES "public"."profiles"("id");


--
-- Name: field_trip_vehicle_assignments field_trip_vehicle_assignments_chaperone_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."field_trip_vehicle_assignments"
    ADD CONSTRAINT "field_trip_vehicle_assignments_chaperone_id_fkey" FOREIGN KEY ("chaperone_id") REFERENCES "public"."field_trip_chaperones"("id") ON DELETE CASCADE;


--
-- Name: field_trip_vehicle_assignments field_trip_vehicle_assignments_field_trip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."field_trip_vehicle_assignments"
    ADD CONSTRAINT "field_trip_vehicle_assignments_field_trip_id_fkey" FOREIGN KEY ("field_trip_id") REFERENCES "public"."field_trips"("id") ON DELETE CASCADE;


--
-- Name: field_trip_vehicle_assignments field_trip_vehicle_assignments_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."field_trip_vehicle_assignments"
    ADD CONSTRAINT "field_trip_vehicle_assignments_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE CASCADE;


--
-- Name: field_trip_vehicle_assignments field_trip_vehicle_assignments_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."field_trip_vehicle_assignments"
    ADD CONSTRAINT "field_trip_vehicle_assignments_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE CASCADE;


--
-- Name: field_trips field_trips_campus_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."field_trips"
    ADD CONSTRAINT "field_trips_campus_id_fkey" FOREIGN KEY ("campus_id") REFERENCES "public"."campuses"("id");


--
-- Name: field_trips field_trips_created_by_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."field_trips"
    ADD CONSTRAINT "field_trips_created_by_profile_id_fkey" FOREIGN KEY ("created_by_profile_id") REFERENCES "public"."profiles"("id");


--
-- Name: field_trips field_trips_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."field_trips"
    ADD CONSTRAINT "field_trips_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE CASCADE;


--
-- Name: students fk_student_bus_group; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."students"
    ADD CONSTRAINT "fk_student_bus_group" FOREIGN KEY ("bus_group_id") REFERENCES "public"."bus_groups"("id") ON DELETE SET NULL;


--
-- Name: guardian_intake_campaigns guardian_intake_campaigns_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."guardian_intake_campaigns"
    ADD CONSTRAINT "guardian_intake_campaigns_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id");


--
-- Name: guardian_intake_campaigns guardian_intake_campaigns_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."guardian_intake_campaigns"
    ADD CONSTRAINT "guardian_intake_campaigns_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE CASCADE;


--
-- Name: guardian_intake_submissions guardian_intake_submissions_campaign_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."guardian_intake_submissions"
    ADD CONSTRAINT "guardian_intake_submissions_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "public"."guardian_intake_campaigns"("id") ON DELETE CASCADE;


--
-- Name: guardian_intake_submissions guardian_intake_submissions_matched_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."guardian_intake_submissions"
    ADD CONSTRAINT "guardian_intake_submissions_matched_family_id_fkey" FOREIGN KEY ("matched_family_id") REFERENCES "public"."families"("id") ON DELETE SET NULL;


--
-- Name: guardian_intake_submissions guardian_intake_submissions_matched_guardian_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."guardian_intake_submissions"
    ADD CONSTRAINT "guardian_intake_submissions_matched_guardian_id_fkey" FOREIGN KEY ("matched_guardian_id") REFERENCES "public"."guardians"("id") ON DELETE SET NULL;


--
-- Name: guardian_intake_submissions guardian_intake_submissions_merged_into_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."guardian_intake_submissions"
    ADD CONSTRAINT "guardian_intake_submissions_merged_into_id_fkey" FOREIGN KEY ("merged_into_id") REFERENCES "public"."guardian_intake_submissions"("id") ON DELETE SET NULL;


--
-- Name: guardian_intake_submissions guardian_intake_submissions_reviewed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."guardian_intake_submissions"
    ADD CONSTRAINT "guardian_intake_submissions_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "public"."profiles"("id");


--
-- Name: guardian_intake_submissions guardian_intake_submissions_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."guardian_intake_submissions"
    ADD CONSTRAINT "guardian_intake_submissions_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id");


--
-- Name: guardians guardians_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."guardians"
    ADD CONSTRAINT "guardians_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE CASCADE;


--
-- Name: guardians guardians_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."guardians"
    ADD CONSTRAINT "guardians_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE CASCADE;


--
-- Name: ic_data_gaps ic_data_gaps_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."ic_data_gaps"
    ADD CONSTRAINT "ic_data_gaps_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id");


--
-- Name: ic_field_diffs ic_field_diffs_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."ic_field_diffs"
    ADD CONSTRAINT "ic_field_diffs_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id");


--
-- Name: ic_reconciliation_candidates ic_reconciliation_candidates_reviewed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."ic_reconciliation_candidates"
    ADD CONSTRAINT "ic_reconciliation_candidates_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "auth"."users"("id");


--
-- Name: ic_reconciliation_candidates ic_reconciliation_candidates_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."ic_reconciliation_candidates"
    ADD CONSTRAINT "ic_reconciliation_candidates_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id");


--
-- Name: ic_sync_field_settings ic_sync_field_settings_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."ic_sync_field_settings"
    ADD CONSTRAINT "ic_sync_field_settings_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id");


--
-- Name: ic_sync_runs ic_sync_runs_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."ic_sync_runs"
    ADD CONSTRAINT "ic_sync_runs_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id");


--
-- Name: inventory_assignments inventory_assignments_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."inventory_assignments"
    ADD CONSTRAINT "inventory_assignments_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "public"."inventory_list_items"("id") ON DELETE CASCADE;


--
-- Name: inventory_assignments inventory_assignments_list_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."inventory_assignments"
    ADD CONSTRAINT "inventory_assignments_list_id_fkey" FOREIGN KEY ("list_id") REFERENCES "public"."inventory_lists"("id") ON DELETE CASCADE;


--
-- Name: inventory_assignments inventory_assignments_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."inventory_assignments"
    ADD CONSTRAINT "inventory_assignments_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE CASCADE;


--
-- Name: inventory_list_items inventory_list_items_list_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."inventory_list_items"
    ADD CONSTRAINT "inventory_list_items_list_id_fkey" FOREIGN KEY ("list_id") REFERENCES "public"."inventory_lists"("id") ON DELETE CASCADE;


--
-- Name: inventory_list_members inventory_list_members_list_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."inventory_list_members"
    ADD CONSTRAINT "inventory_list_members_list_id_fkey" FOREIGN KEY ("list_id") REFERENCES "public"."inventory_lists"("id") ON DELETE CASCADE;


--
-- Name: inventory_list_members inventory_list_members_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."inventory_list_members"
    ADD CONSTRAINT "inventory_list_members_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE CASCADE;


--
-- Name: inventory_lists inventory_lists_owner_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."inventory_lists"
    ADD CONSTRAINT "inventory_lists_owner_profile_id_fkey" FOREIGN KEY ("owner_profile_id") REFERENCES "public"."profiles"("id");


--
-- Name: inventory_lists inventory_lists_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."inventory_lists"
    ADD CONSTRAINT "inventory_lists_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE CASCADE;


--
-- Name: license_alert_log license_alert_log_license_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."license_alert_log"
    ADD CONSTRAINT "license_alert_log_license_id_fkey" FOREIGN KEY ("license_id") REFERENCES "public"."staff_licenses"("id") ON DELETE CASCADE;


--
-- Name: permission_audit_log permission_audit_log_changed_by_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."permission_audit_log"
    ADD CONSTRAINT "permission_audit_log_changed_by_profile_id_fkey" FOREIGN KEY ("changed_by_profile_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;


--
-- Name: permission_audit_log permission_audit_log_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."permission_audit_log"
    ADD CONSTRAINT "permission_audit_log_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE CASCADE;


--
-- Name: permission_audit_log permission_audit_log_target_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."permission_audit_log"
    ADD CONSTRAINT "permission_audit_log_target_profile_id_fkey" FOREIGN KEY ("target_profile_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;


--
-- Name: placement_assignments placement_assignments_assigned_col_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."placement_assignments"
    ADD CONSTRAINT "placement_assignments_assigned_col_id_fkey" FOREIGN KEY ("assigned_col_id") REFERENCES "public"."placement_session_teachers"("id") ON DELETE SET NULL;


--
-- Name: placement_assignments placement_assignments_prev_homeroom_teacher_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."placement_assignments"
    ADD CONSTRAINT "placement_assignments_prev_homeroom_teacher_id_fkey" FOREIGN KEY ("prev_homeroom_teacher_id") REFERENCES "public"."employees"("id") ON DELETE SET NULL;


--
-- Name: placement_assignments placement_assignments_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."placement_assignments"
    ADD CONSTRAINT "placement_assignments_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."placement_sessions"("id") ON DELETE CASCADE;


--
-- Name: placement_assignments placement_assignments_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."placement_assignments"
    ADD CONSTRAINT "placement_assignments_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE CASCADE;


--
-- Name: placement_assignments placement_assignments_teacher_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."placement_assignments"
    ADD CONSTRAINT "placement_assignments_teacher_id_fkey" FOREIGN KEY ("teacher_id") REFERENCES "public"."employees"("id") ON DELETE SET NULL;


--
-- Name: placement_audit_log placement_audit_log_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."placement_audit_log"
    ADD CONSTRAINT "placement_audit_log_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id");


--
-- Name: placement_audit_log placement_audit_log_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."placement_audit_log"
    ADD CONSTRAINT "placement_audit_log_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."placement_sessions"("id") ON DELETE CASCADE;


--
-- Name: placement_flags placement_flags_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."placement_flags"
    ADD CONSTRAINT "placement_flags_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE CASCADE;


--
-- Name: placement_session_notes placement_session_notes_author_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."placement_session_notes"
    ADD CONSTRAINT "placement_session_notes_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;


--
-- Name: placement_session_notes placement_session_notes_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."placement_session_notes"
    ADD CONSTRAINT "placement_session_notes_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."placement_sessions"("id") ON DELETE CASCADE;


--
-- Name: placement_session_teachers placement_session_teachers_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."placement_session_teachers"
    ADD CONSTRAINT "placement_session_teachers_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."placement_sessions"("id") ON DELETE CASCADE;


--
-- Name: placement_session_teachers placement_session_teachers_teacher_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."placement_session_teachers"
    ADD CONSTRAINT "placement_session_teachers_teacher_id_fkey" FOREIGN KEY ("teacher_id") REFERENCES "public"."employees"("id") ON DELETE SET NULL;


--
-- Name: placement_sessions placement_sessions_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."placement_sessions"
    ADD CONSTRAINT "placement_sessions_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE CASCADE;


--
-- Name: profiles profiles_active_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_active_school_id_fkey" FOREIGN KEY ("active_school_id") REFERENCES "public"."schools"("id") ON DELETE SET NULL;


--
-- Name: profiles profiles_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE SET NULL;


--
-- Name: profiles profiles_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE SET NULL;


--
-- Name: profiles profiles_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;


--
-- Name: pto_balances pto_balances_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."pto_balances"
    ADD CONSTRAINT "pto_balances_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE CASCADE;


--
-- Name: pto_balances pto_balances_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."pto_balances"
    ADD CONSTRAINT "pto_balances_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE CASCADE;


--
-- Name: pto_ledger pto_ledger_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."pto_ledger"
    ADD CONSTRAINT "pto_ledger_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."employees"("id") ON DELETE SET NULL;


--
-- Name: pto_ledger pto_ledger_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."pto_ledger"
    ADD CONSTRAINT "pto_ledger_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE CASCADE;


--
-- Name: pto_ledger pto_ledger_related_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."pto_ledger"
    ADD CONSTRAINT "pto_ledger_related_request_id_fkey" FOREIGN KEY ("related_request_id") REFERENCES "public"."pto_requests"("id");


--
-- Name: pto_ledger pto_ledger_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."pto_ledger"
    ADD CONSTRAINT "pto_ledger_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE CASCADE;


--
-- Name: pto_requests pto_requests_decided_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."pto_requests"
    ADD CONSTRAINT "pto_requests_decided_by_fkey" FOREIGN KEY ("decided_by") REFERENCES "public"."employees"("id") ON DELETE SET NULL;


--
-- Name: pto_requests pto_requests_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."pto_requests"
    ADD CONSTRAINT "pto_requests_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE CASCADE;


--
-- Name: pto_requests pto_requests_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."pto_requests"
    ADD CONSTRAINT "pto_requests_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE CASCADE;


--
-- Name: pto_requests pto_requests_sub_coverage_notified_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."pto_requests"
    ADD CONSTRAINT "pto_requests_sub_coverage_notified_by_fkey" FOREIGN KEY ("sub_coverage_notified_by") REFERENCES "public"."employees"("id");


--
-- Name: pto_requests pto_requests_submitted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."pto_requests"
    ADD CONSTRAINT "pto_requests_submitted_by_fkey" FOREIGN KEY ("submitted_by") REFERENCES "public"."employees"("id");


--
-- Name: request_categories request_categories_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."request_categories"
    ADD CONSTRAINT "request_categories_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;


--
-- Name: request_categories request_categories_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."request_categories"
    ADD CONSTRAINT "request_categories_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE CASCADE;


--
-- Name: request_category_fields request_category_fields_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."request_category_fields"
    ADD CONSTRAINT "request_category_fields_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "public"."request_categories"("id") ON DELETE CASCADE;


--
-- Name: request_category_managers request_category_managers_added_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."request_category_managers"
    ADD CONSTRAINT "request_category_managers_added_by_fkey" FOREIGN KEY ("added_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;


--
-- Name: request_category_managers request_category_managers_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."request_category_managers"
    ADD CONSTRAINT "request_category_managers_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "public"."request_categories"("id") ON DELETE CASCADE;


--
-- Name: request_category_managers request_category_managers_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."request_category_managers"
    ADD CONSTRAINT "request_category_managers_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;


--
-- Name: request_category_visibility request_category_visibility_added_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."request_category_visibility"
    ADD CONSTRAINT "request_category_visibility_added_by_fkey" FOREIGN KEY ("added_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;


--
-- Name: request_category_visibility request_category_visibility_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."request_category_visibility"
    ADD CONSTRAINT "request_category_visibility_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "public"."request_categories"("id") ON DELETE CASCADE;


--
-- Name: request_category_visibility request_category_visibility_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."request_category_visibility"
    ADD CONSTRAINT "request_category_visibility_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;


--
-- Name: reservable_resources reservable_resources_campus_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."reservable_resources"
    ADD CONSTRAINT "reservable_resources_campus_id_fkey" FOREIGN KEY ("campus_id") REFERENCES "public"."campuses"("id") ON DELETE SET NULL;


--
-- Name: reservable_resources reservable_resources_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."reservable_resources"
    ADD CONSTRAINT "reservable_resources_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "public"."resource_groups"("id") ON DELETE SET NULL;


--
-- Name: reservable_resources reservable_resources_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."reservable_resources"
    ADD CONSTRAINT "reservable_resources_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE CASCADE;


--
-- Name: reservations reservations_decided_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."reservations"
    ADD CONSTRAINT "reservations_decided_by_fkey" FOREIGN KEY ("decided_by") REFERENCES "public"."profiles"("id");


--
-- Name: reservations reservations_reserved_by_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."reservations"
    ADD CONSTRAINT "reservations_reserved_by_profile_id_fkey" FOREIGN KEY ("reserved_by_profile_id") REFERENCES "public"."profiles"("id");


--
-- Name: reservations reservations_resource_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."reservations"
    ADD CONSTRAINT "reservations_resource_id_fkey" FOREIGN KEY ("resource_id") REFERENCES "public"."reservable_resources"("id") ON DELETE CASCADE;


--
-- Name: reservations reservations_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."reservations"
    ADD CONSTRAINT "reservations_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE CASCADE;


--
-- Name: resource_document_bookmarks resource_document_bookmarks_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."resource_document_bookmarks"
    ADD CONSTRAINT "resource_document_bookmarks_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "public"."resource_documents"("id") ON DELETE CASCADE;


--
-- Name: resource_document_bookmarks resource_document_bookmarks_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."resource_document_bookmarks"
    ADD CONSTRAINT "resource_document_bookmarks_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;


--
-- Name: resource_document_categories resource_document_categories_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."resource_document_categories"
    ADD CONSTRAINT "resource_document_categories_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;


--
-- Name: resource_document_categories resource_document_categories_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."resource_document_categories"
    ADD CONSTRAINT "resource_document_categories_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE CASCADE;


--
-- Name: resource_documents resource_documents_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."resource_documents"
    ADD CONSTRAINT "resource_documents_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "public"."resource_document_categories"("id") ON DELETE SET NULL;


--
-- Name: resource_documents resource_documents_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."resource_documents"
    ADD CONSTRAINT "resource_documents_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE CASCADE;


--
-- Name: resource_documents resource_documents_uploaded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."resource_documents"
    ADD CONSTRAINT "resource_documents_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "public"."profiles"("id");


--
-- Name: resource_groups resource_groups_campus_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."resource_groups"
    ADD CONSTRAINT "resource_groups_campus_id_fkey" FOREIGN KEY ("campus_id") REFERENCES "public"."campuses"("id") ON DELETE SET NULL;


--
-- Name: resource_groups resource_groups_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."resource_groups"
    ADD CONSTRAINT "resource_groups_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE CASCADE;


--
-- Name: resource_time_blocks resource_time_blocks_campus_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."resource_time_blocks"
    ADD CONSTRAINT "resource_time_blocks_campus_id_fkey" FOREIGN KEY ("campus_id") REFERENCES "public"."campuses"("id") ON DELETE SET NULL;


--
-- Name: resource_time_blocks resource_time_blocks_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."resource_time_blocks"
    ADD CONSTRAINT "resource_time_blocks_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE CASCADE;


--
-- Name: school_calendar_events school_calendar_events_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."school_calendar_events"
    ADD CONSTRAINT "school_calendar_events_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE CASCADE;


--
-- Name: school_domains school_domains_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."school_domains"
    ADD CONSTRAINT "school_domains_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE CASCADE;


--
-- Name: school_modules school_modules_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."school_modules"
    ADD CONSTRAINT "school_modules_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE CASCADE;


--
-- Name: school_pto_types school_pto_types_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."school_pto_types"
    ADD CONSTRAINT "school_pto_types_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE CASCADE;


--
-- Name: school_settings school_settings_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."school_settings"
    ADD CONSTRAINT "school_settings_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE CASCADE;


--
-- Name: staff_groups staff_groups_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."staff_groups"
    ADD CONSTRAINT "staff_groups_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE CASCADE;


--
-- Name: staff_license_ceus staff_license_ceus_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."staff_license_ceus"
    ADD CONSTRAINT "staff_license_ceus_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE CASCADE;


--
-- Name: staff_license_ceus staff_license_ceus_license_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."staff_license_ceus"
    ADD CONSTRAINT "staff_license_ceus_license_id_fkey" FOREIGN KEY ("license_id") REFERENCES "public"."staff_licenses"("id") ON DELETE CASCADE;


--
-- Name: staff_license_ceus staff_license_ceus_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."staff_license_ceus"
    ADD CONSTRAINT "staff_license_ceus_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE CASCADE;


--
-- Name: staff_license_files staff_license_files_license_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."staff_license_files"
    ADD CONSTRAINT "staff_license_files_license_id_fkey" FOREIGN KEY ("license_id") REFERENCES "public"."staff_licenses"("id") ON DELETE CASCADE;


--
-- Name: staff_license_files staff_license_files_uploaded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."staff_license_files"
    ADD CONSTRAINT "staff_license_files_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;


--
-- Name: staff_license_history staff_license_history_license_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."staff_license_history"
    ADD CONSTRAINT "staff_license_history_license_id_fkey" FOREIGN KEY ("license_id") REFERENCES "public"."staff_licenses"("id") ON DELETE CASCADE;


--
-- Name: staff_licenses staff_licenses_campus_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."staff_licenses"
    ADD CONSTRAINT "staff_licenses_campus_id_fkey" FOREIGN KEY ("campus_id") REFERENCES "public"."campuses"("id") ON DELETE SET NULL;


--
-- Name: staff_licenses staff_licenses_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."staff_licenses"
    ADD CONSTRAINT "staff_licenses_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE CASCADE;


--
-- Name: staff_licenses staff_licenses_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."staff_licenses"
    ADD CONSTRAINT "staff_licenses_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE CASCADE;


--
-- Name: staff_request_responses staff_request_responses_field_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."staff_request_responses"
    ADD CONSTRAINT "staff_request_responses_field_id_fkey" FOREIGN KEY ("field_id") REFERENCES "public"."request_category_fields"("id");


--
-- Name: staff_request_responses staff_request_responses_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."staff_request_responses"
    ADD CONSTRAINT "staff_request_responses_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "public"."staff_requests"("id") ON DELETE CASCADE;


--
-- Name: staff_requests staff_requests_assigned_manager_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."staff_requests"
    ADD CONSTRAINT "staff_requests_assigned_manager_id_fkey" FOREIGN KEY ("assigned_manager_id") REFERENCES "public"."profiles"("id");


--
-- Name: staff_requests staff_requests_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."staff_requests"
    ADD CONSTRAINT "staff_requests_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "public"."request_categories"("id");


--
-- Name: staff_requests staff_requests_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."staff_requests"
    ADD CONSTRAINT "staff_requests_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE CASCADE;


--
-- Name: staff_requests staff_requests_submitted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."staff_requests"
    ADD CONSTRAINT "staff_requests_submitted_by_fkey" FOREIGN KEY ("submitted_by") REFERENCES "public"."profiles"("id");


--
-- Name: student_placement_flags student_placement_flags_flag_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."student_placement_flags"
    ADD CONSTRAINT "student_placement_flags_flag_id_fkey" FOREIGN KEY ("flag_id") REFERENCES "public"."placement_flags"("id") ON DELETE CASCADE;


--
-- Name: student_placement_flags student_placement_flags_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."student_placement_flags"
    ADD CONSTRAINT "student_placement_flags_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE CASCADE;


--
-- Name: student_promotion_log student_promotion_log_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."student_promotion_log"
    ADD CONSTRAINT "student_promotion_log_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE CASCADE;


--
-- Name: students students_campus_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."students"
    ADD CONSTRAINT "students_campus_id_fkey" FOREIGN KEY ("campus_id") REFERENCES "public"."campuses"("id") ON DELETE SET NULL;


--
-- Name: students students_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."students"
    ADD CONSTRAINT "students_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE SET NULL;


--
-- Name: students students_homeroom_teacher_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."students"
    ADD CONSTRAINT "students_homeroom_teacher_fkey" FOREIGN KEY ("homeroom_teacher_id") REFERENCES "public"."employees"("id");


--
-- Name: students students_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."students"
    ADD CONSTRAINT "students_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE CASCADE;


--
-- Name: substitute_assignments substitute_assignments_covered_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."substitute_assignments"
    ADD CONSTRAINT "substitute_assignments_covered_employee_id_fkey" FOREIGN KEY ("covered_employee_id") REFERENCES "public"."employees"("id");


--
-- Name: substitute_assignments substitute_assignments_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."substitute_assignments"
    ADD CONSTRAINT "substitute_assignments_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id");


--
-- Name: substitute_assignments substitute_assignments_pto_request_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."substitute_assignments"
    ADD CONSTRAINT "substitute_assignments_pto_request_fkey" FOREIGN KEY ("pto_request_id") REFERENCES "public"."pto_requests"("id");


--
-- Name: substitute_assignments substitute_assignments_pto_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."substitute_assignments"
    ADD CONSTRAINT "substitute_assignments_pto_request_id_fkey" FOREIGN KEY ("pto_request_id") REFERENCES "public"."pto_requests"("id");


--
-- Name: substitute_assignments substitute_assignments_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."substitute_assignments"
    ADD CONSTRAINT "substitute_assignments_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE CASCADE;


--
-- Name: substitute_assignments substitute_assignments_substitute_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."substitute_assignments"
    ADD CONSTRAINT "substitute_assignments_substitute_id_fkey" FOREIGN KEY ("substitute_id") REFERENCES "public"."substitutes"("id") ON DELETE CASCADE;


--
-- Name: substitutes substitutes_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."substitutes"
    ADD CONSTRAINT "substitutes_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE CASCADE;


--
-- Name: guardians Admins can insert guardians; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Admins can insert guardians" ON "public"."guardians" FOR INSERT TO "authenticated" WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."user_id" = "auth"."uid"()) AND ("profiles"."school_id" = "guardians"."school_id") AND ("profiles"."can_manage_guardians" = true)))));


--
-- Name: employee_pto_policies Admins can manage PTO policies for their school; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Admins can manage PTO policies for their school" ON "public"."employee_pto_policies" USING ((EXISTS ( SELECT 1
   FROM ("public"."employees" "e"
     JOIN "public"."profiles" "p" ON (("p"."user_id" = ( SELECT "auth"."uid"() AS "uid"))))
  WHERE (("e"."id" = "employee_pto_policies"."employee_id") AND ("e"."school_id" = "p"."school_id") AND ("p"."can_adjust_pto" = true))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM ("public"."employees" "e"
     JOIN "public"."profiles" "p" ON (("p"."user_id" = ( SELECT "auth"."uid"() AS "uid"))))
  WHERE (("e"."id" = "employee_pto_policies"."employee_id") AND ("e"."school_id" = "p"."school_id") AND ("p"."can_adjust_pto" = true)))));


--
-- Name: student_promotion_log Admins can manage promotion logs; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Admins can manage promotion logs" ON "public"."student_promotion_log" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."status" = 'active'::"text") AND (("p"."is_superadmin" = true) OR (("p"."role" = 'admin'::"text") AND ("p"."school_id" = "student_promotion_log"."school_id")))))));


--
-- Name: employee_pto_policies Admins can read PTO policies for their school; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Admins can read PTO policies for their school" ON "public"."employee_pto_policies" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM ("public"."employees" "e"
     JOIN "public"."profiles" "p" ON (("p"."user_id" = "auth"."uid"())))
  WHERE (("e"."id" = "employee_pto_policies"."employee_id") AND ("e"."school_id" = "p"."school_id")))));


--
-- Name: school_modules Admins can read modules; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Admins can read modules" ON "public"."school_modules" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."school_id" = "school_modules"."school_id")))));


--
-- Name: profiles Admins can read users in their school; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Admins can read users in their school" ON "public"."profiles" FOR SELECT TO "authenticated" USING ((("school_id" = "public"."current_user_school_id"()) AND ("public"."current_user_can_manage_access"() OR "public"."current_user_can_manage_requests"())));


--
-- Name: school_pto_types Allow managers to update PTO types for their school; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Allow managers to update PTO types for their school" ON "public"."school_pto_types" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."school_id" = "school_pto_types"."school_id") AND (("p"."can_manage_pto_balances" = true) OR ("p"."is_superadmin" = true)))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."school_id" = "school_pto_types"."school_id") AND (("p"."can_manage_pto_balances" = true) OR ("p"."is_superadmin" = true))))));


--
-- Name: school_pto_types Allow users to read PTO types for their school; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Allow users to read PTO types for their school" ON "public"."school_pto_types" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."school_id" = "school_pto_types"."school_id")))));


--
-- Name: schools Authenticated users can read schools; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Authenticated users can read schools" ON "public"."schools" FOR SELECT TO "authenticated" USING (true);


--
-- Name: staff_license_ceus CEUs: admin delete; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "CEUs: admin delete" ON "public"."staff_license_ceus" FOR DELETE USING ("public"."current_user_can_manage_licensure"("school_id"));


--
-- Name: staff_license_ceus CEUs: admin insert; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "CEUs: admin insert" ON "public"."staff_license_ceus" FOR INSERT WITH CHECK ("public"."current_user_can_manage_licensure"("school_id"));


--
-- Name: staff_license_ceus CEUs: admin select; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "CEUs: admin select" ON "public"."staff_license_ceus" FOR SELECT USING ("public"."current_user_can_manage_licensure"("school_id"));


--
-- Name: staff_license_ceus CEUs: admin update; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "CEUs: admin update" ON "public"."staff_license_ceus" FOR UPDATE USING ("public"."current_user_can_manage_licensure"("school_id"));


--
-- Name: staff_license_ceus CEUs: staff own select; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "CEUs: staff own select" ON "public"."staff_license_ceus" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."employee_id" = "staff_license_ceus"."employee_id")))));


--
-- Name: school_calendar_events Calendar managers manage calendar events; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Calendar managers manage calendar events" ON "public"."school_calendar_events" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND (("p"."is_superadmin" = true) OR (("p"."school_id" = "school_calendar_events"."school_id") AND (("p"."role" = 'admin'::"text") OR ("p"."can_manage_calendar" = true)))))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND (("p"."is_superadmin" = true) OR (("p"."school_id" = "school_calendar_events"."school_id") AND (("p"."role" = 'admin'::"text") OR ("p"."can_manage_calendar" = true))))))));


--
-- Name: staff_groups Campus managers can manage staff groups; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Campus managers can manage staff groups" ON "public"."staff_groups" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."school_id" = "staff_groups"."school_id") AND (("p"."can_manage_campuses" = true) OR ("p"."is_superadmin" = true)))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."school_id" = "staff_groups"."school_id") AND (("p"."can_manage_campuses" = true) OR ("p"."is_superadmin" = true))))));


--
-- Name: profiles Category managers can read submitter profiles; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Category managers can read submitter profiles" ON "public"."profiles" FOR SELECT USING ("public"."current_user_manages_submitter"("id"));


--
-- Name: license_alert_log License alerts: admin select; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "License alerts: admin select" ON "public"."license_alert_log" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."school_id" = "license_alert_log"."school_id") AND ("p"."is_superadmin" OR "p"."can_manage_licensure")))));


--
-- Name: license_alert_log License alerts: insert; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "License alerts: insert" ON "public"."license_alert_log" FOR INSERT WITH CHECK (("school_id" = ( SELECT "profiles"."school_id"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"()))));


--
-- Name: staff_license_files License files: insert; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "License files: insert" ON "public"."staff_license_files" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."school_id" = "staff_license_files"."school_id") AND ("p"."is_superadmin" OR "p"."can_manage_licensure")))));


--
-- Name: staff_license_files License files: select; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "License files: select" ON "public"."staff_license_files" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."school_id" = "staff_license_files"."school_id") AND ("p"."is_superadmin" OR "p"."can_manage_licensure")))));


--
-- Name: staff_license_files License files: select own; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "License files: select own" ON "public"."staff_license_files" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM ("public"."staff_licenses" "sl"
     JOIN "public"."profiles" "p" ON (("p"."employee_id" = "sl"."employee_id")))
  WHERE (("sl"."id" = "staff_license_files"."license_id") AND ("p"."user_id" = "auth"."uid"())))));


--
-- Name: staff_license_files License files: update; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "License files: update" ON "public"."staff_license_files" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."school_id" = "staff_license_files"."school_id") AND ("p"."is_superadmin" OR "p"."can_manage_licensure")))));


--
-- Name: staff_license_history License history: admin select; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "License history: admin select" ON "public"."staff_license_history" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."school_id" = "staff_license_history"."school_id") AND ("p"."is_superadmin" OR "p"."can_manage_licensure")))));


--
-- Name: staff_license_history License history: insert; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "License history: insert" ON "public"."staff_license_history" FOR INSERT WITH CHECK (("school_id" = ( SELECT "profiles"."school_id"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"()))));


--
-- Name: staff_licenses Licenses: admin delete; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Licenses: admin delete" ON "public"."staff_licenses" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE ((("p"."user_id" = ( SELECT "auth"."uid"())) AND ("p"."school_id" = "staff_licenses"."school_id") AND ("p"."is_superadmin" OR "p"."can_manage_licensure"))))));


--
-- Name: staff_licenses Licenses: admin insert; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Licenses: admin insert" ON "public"."staff_licenses" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE ((("p"."user_id" = ( SELECT "auth"."uid"())) AND ("p"."school_id" = "staff_licenses"."school_id") AND ("p"."is_superadmin" OR "p"."can_manage_licensure"))))));


--
-- Name: staff_licenses Licenses: admin select; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Licenses: admin select" ON "public"."staff_licenses" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE ((("p"."user_id" = ( SELECT "auth"."uid"())) AND ("p"."school_id" = "staff_licenses"."school_id") AND ("p"."is_superadmin" OR "p"."can_manage_licensure"))))));


--
-- Name: staff_licenses Licenses: admin update; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Licenses: admin update" ON "public"."staff_licenses" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE ((("p"."user_id" = ( SELECT "auth"."uid"())) AND ("p"."school_id" = "staff_licenses"."school_id") AND ("p"."is_superadmin" OR "p"."can_manage_licensure"))))));


--
-- Name: staff_licenses Licenses: staff own select; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Licenses: staff own select" ON "public"."staff_licenses" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = ( SELECT "auth"."uid"())) AND ("p"."employee_id" = "staff_licenses"."employee_id")))));


--
-- Name: profiles Only access managers may update profiles; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Only access managers may update profiles" ON "public"."profiles" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."school_id" = "profiles"."school_id") AND (("p"."can_manage_access" = true) OR ("p"."is_superadmin" = true)))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."school_id" = "profiles"."school_id") AND (("p"."can_manage_access" = true) OR ("p"."is_superadmin" = true))))));


--
-- Name: pto_requests Only approvers can update PTO requests; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Only approvers can update PTO requests" ON "public"."pto_requests" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."school_id" = "pto_requests"."school_id") AND ("p"."can_approve_pto" = true))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."school_id" = "pto_requests"."school_id") AND ("p"."can_approve_pto" = true)))));


--
-- Name: guardians Profiles with can_manage_guardians can delete guardians; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Profiles with can_manage_guardians can delete guardians" ON "public"."guardians" FOR DELETE TO "authenticated" USING ((("auth"."uid"() IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."school_id" = "guardians"."school_id") AND ("p"."can_manage_guardians" = true))))));


--
-- Name: guardians Profiles with can_manage_guardians can update guardians; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Profiles with can_manage_guardians can update guardians" ON "public"."guardians" FOR UPDATE TO "authenticated" USING ((("auth"."uid"() IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."school_id" = "guardians"."school_id") AND ("p"."can_manage_guardians" = true)))))) WITH CHECK ((("school_id" IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."school_id" = "guardians"."school_id") AND ("p"."can_manage_guardians" = true))))));


--
-- Name: staff_groups School members can view staff groups; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "School members can view staff groups" ON "public"."staff_groups" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."school_id" = "staff_groups"."school_id")))));


--
-- Name: school_calendar_events School members read calendar events; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "School members read calendar events" ON "public"."school_calendar_events" FOR SELECT USING (("school_id" = ( SELECT "profiles"."school_id"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"())
 LIMIT 1)));


--
-- Name: pto_requests Staff can request cancellation of their own PTO; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Staff can request cancellation of their own PTO" ON "public"."pto_requests" FOR UPDATE TO "authenticated" USING (("employee_id" = ( SELECT "profiles"."employee_id"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"())))) WITH CHECK ((("employee_id" = ( SELECT "profiles"."employee_id"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"()))) AND ("status" = ANY (ARRAY['CANCEL_REQUESTED'::"public"."pto_status", 'RESCIND_REQUESTED'::"public"."pto_status", 'CANCELLED'::"public"."pto_status"]))));


--
-- Name: substitute_assignments Sub assignments: delete own school; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Sub assignments: delete own school" ON "public"."substitute_assignments" FOR DELETE USING (("school_id" = ( SELECT "profiles"."school_id"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"()))));


--
-- Name: substitute_assignments Sub assignments: insert own school; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Sub assignments: insert own school" ON "public"."substitute_assignments" FOR INSERT WITH CHECK (("school_id" = ( SELECT "profiles"."school_id"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"()))));


--
-- Name: substitute_assignments Sub assignments: read own school; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Sub assignments: read own school" ON "public"."substitute_assignments" FOR SELECT USING (("school_id" = ( SELECT "profiles"."school_id"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"()))));


--
-- Name: substitute_assignments Sub assignments: update own school; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Sub assignments: update own school" ON "public"."substitute_assignments" FOR UPDATE USING (("school_id" = ( SELECT "profiles"."school_id"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"()))));


--
-- Name: substitutes Substitutes: delete for own school; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Substitutes: delete for own school" ON "public"."substitutes" FOR DELETE USING (("school_id" = ( SELECT "profiles"."school_id"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = ( SELECT "auth"."uid"())))));


--
-- Name: substitutes Substitutes: insert for own school; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Substitutes: insert for own school" ON "public"."substitutes" FOR INSERT WITH CHECK (("school_id" = ( SELECT "profiles"."school_id"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = ( SELECT "auth"."uid"())))));


--
-- Name: substitutes Substitutes: read by school; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Substitutes: read by school" ON "public"."substitutes" FOR SELECT USING (("school_id" = ( SELECT "profiles"."school_id"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = ( SELECT "auth"."uid"())))));


--
-- Name: substitutes Substitutes: update for own school; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Substitutes: update for own school" ON "public"."substitutes" FOR UPDATE USING (("school_id" = ( SELECT "profiles"."school_id"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = ( SELECT "auth"."uid"())))));


--
-- Name: profiles Users can create their own profile; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Users can create their own profile" ON "public"."profiles" FOR INSERT TO "authenticated" WITH CHECK (("auth"."uid"() = "user_id"));


--
-- Name: profiles Users can read their own profile; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Users can read their own profile" ON "public"."profiles" FOR SELECT TO "authenticated" USING (("auth"."uid"() = "user_id"));


--
-- Name: campuses access managers write campuses; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "access managers write campuses" ON "public"."campuses" TO "authenticated" USING ((("school_id" = ( SELECT "profiles"."school_id"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"()))) AND ( SELECT "profiles"."can_manage_access"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"()))));


--
-- Name: access_requests; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."access_requests" ENABLE ROW LEVEL SECURITY;

--
-- Name: access_requests access_requests_admin_read; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "access_requests_admin_read" ON "public"."access_requests" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."status" = 'active'::"text") AND (("p"."is_superadmin" = true) OR (("p"."can_manage_access" = true) AND ("p"."school_id" = "access_requests"."school_id")))))));


--
-- Name: access_requests access_requests_admin_update; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "access_requests_admin_update" ON "public"."access_requests" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."status" = 'active'::"text") AND (("p"."is_superadmin" = true) OR (("p"."can_manage_access" = true) AND ("p"."school_id" = "access_requests"."school_id"))))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."status" = 'active'::"text") AND (("p"."is_superadmin" = true) OR (("p"."can_manage_access" = true) AND ("p"."school_id" = "access_requests"."school_id")))))));


--
-- Name: access_requests access_requests_self_delete; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "access_requests_self_delete" ON "public"."access_requests" FOR DELETE USING ((("status" = 'pending'::"text") AND (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."status" = 'active'::"text") AND ("p"."employee_id" = "access_requests"."employee_id"))))));


--
-- Name: access_requests access_requests_self_insert; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "access_requests_self_insert" ON "public"."access_requests" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."status" = 'active'::"text") AND ("p"."school_id" = "access_requests"."school_id") AND ("p"."employee_id" = "access_requests"."employee_id")))));


--
-- Name: access_requests access_requests_self_read; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "access_requests_self_read" ON "public"."access_requests" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."status" = 'active'::"text") AND ("p"."employee_id" = "access_requests"."employee_id")))));


--
-- Name: compliance_bg_check_requests bg_check_ft_read; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "bg_check_ft_read" ON "public"."compliance_bg_check_requests" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."school_id" = "compliance_bg_check_requests"."school_id") AND (("p"."can_manage_field_trips" = true) OR ("p"."is_superadmin" = true) OR (EXISTS ( SELECT 1
           FROM ("public"."field_trip_managers" "m"
             JOIN "public"."field_trips" "ft" ON (("ft"."id" = "m"."field_trip_id")))
          WHERE (("m"."profile_id" = "p"."id") AND ("ft"."school_id" = "compliance_bg_check_requests"."school_id")))))))));


--
-- Name: compliance_bg_check_requests bg_check_manager_insert; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "bg_check_manager_insert" ON "public"."compliance_bg_check_requests" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."school_id" = "compliance_bg_check_requests"."school_id") AND (("p"."can_manage_compliance" = true) OR ("p"."is_superadmin" = true))))));


--
-- Name: compliance_bg_check_requests bg_check_manager_read; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "bg_check_manager_read" ON "public"."compliance_bg_check_requests" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."school_id" = "compliance_bg_check_requests"."school_id") AND (("p"."can_manage_compliance" = true) OR ("p"."is_superadmin" = true))))));


--
-- Name: compliance_bg_check_requests bg_check_manager_update; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "bg_check_manager_update" ON "public"."compliance_bg_check_requests" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."school_id" = "compliance_bg_check_requests"."school_id") AND (("p"."can_manage_compliance" = true) OR ("p"."is_superadmin" = true))))));


--
-- Name: compliance_bg_check_requests bg_check_staff_cancel; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "bg_check_staff_cancel" ON "public"."compliance_bg_check_requests" FOR UPDATE USING ((("requestor_id" = ( SELECT "profiles"."id"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"()))) AND ("status" = 'pending'::"text"))) WITH CHECK (("status" = 'cancelled'::"text"));


--
-- Name: compliance_bg_check_requests bg_check_staff_insert; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "bg_check_staff_insert" ON "public"."compliance_bg_check_requests" FOR INSERT WITH CHECK (("requestor_id" = ( SELECT "profiles"."id"
   FROM "public"."profiles"
  WHERE (("profiles"."user_id" = "auth"."uid"()) AND ("profiles"."school_id" = "compliance_bg_check_requests"."school_id")))));


--
-- Name: compliance_bg_check_requests bg_check_staff_read; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "bg_check_staff_read" ON "public"."compliance_bg_check_requests" FOR SELECT USING (("requestor_id" = ( SELECT "profiles"."id"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"()))));


--
-- Name: bulk_upload_logs; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."bulk_upload_logs" ENABLE ROW LEVEL SECURITY;

--
-- Name: bus_groups; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."bus_groups" ENABLE ROW LEVEL SECURITY;

--
-- Name: bus_groups bus_groups_delete_admin; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "bus_groups_delete_admin" ON "public"."bus_groups" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."status" = 'active'::"text") AND (("p"."is_superadmin" = true) OR (("p"."role" = 'admin'::"text") AND ("p"."school_id" = "bus_groups"."school_id")) OR (("p"."can_manage_bus_groups" = true) AND ("p"."school_id" = "bus_groups"."school_id")))))));


--
-- Name: bus_groups bus_groups_insert_admin; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "bus_groups_insert_admin" ON "public"."bus_groups" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."status" = 'active'::"text") AND (("p"."is_superadmin" = true) OR (("p"."role" = 'admin'::"text") AND ("p"."school_id" = "bus_groups"."school_id")))))));


--
-- Name: bus_groups bus_groups_insert_manage_bus_groups; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "bus_groups_insert_manage_bus_groups" ON "public"."bus_groups" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."status" = 'active'::"text") AND ("p"."school_id" = "bus_groups"."school_id") AND ("p"."can_manage_bus_groups" = true)))));


--
-- Name: bus_groups bus_groups_read_same_school; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "bus_groups_read_same_school" ON "public"."bus_groups" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."status" = 'active'::"text") AND (("p"."is_superadmin" = true) OR ("p"."school_id" = "bus_groups"."school_id"))))));


--
-- Name: bus_groups bus_groups_update_admin; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "bus_groups_update_admin" ON "public"."bus_groups" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."status" = 'active'::"text") AND (("p"."is_superadmin" = true) OR (("p"."role" = 'admin'::"text") AND ("p"."school_id" = "bus_groups"."school_id"))))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."status" = 'active'::"text") AND (("p"."is_superadmin" = true) OR (("p"."role" = 'admin'::"text") AND ("p"."school_id" = "bus_groups"."school_id")))))));


--
-- Name: bus_groups bus_groups_update_manage_bus_groups; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "bus_groups_update_manage_bus_groups" ON "public"."bus_groups" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."status" = 'active'::"text") AND ("p"."school_id" = "bus_groups"."school_id") AND ("p"."can_manage_bus_groups" = true))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."status" = 'active'::"text") AND ("p"."school_id" = "bus_groups"."school_id") AND ("p"."can_manage_bus_groups" = true)))));


--
-- Name: campuses; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."campuses" ENABLE ROW LEVEL SECURITY;

--
-- Name: school_settings carline managers can insert school settings; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "carline managers can insert school settings" ON "public"."school_settings" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."status" = 'active'::"text") AND (("p"."is_superadmin" = true) OR (("p"."school_id" = "school_settings"."school_id") AND (("p"."role" = 'admin'::"text") OR ("p"."can_manage_carline" = true))))))));


--
-- Name: school_settings carline managers can update school settings; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "carline managers can update school settings" ON "public"."school_settings" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."status" = 'active'::"text") AND (("p"."is_superadmin" = true) OR (("p"."school_id" = "school_settings"."school_id") AND (("p"."role" = 'admin'::"text") OR ("p"."can_manage_carline" = true)))))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."status" = 'active'::"text") AND (("p"."is_superadmin" = true) OR (("p"."school_id" = "school_settings"."school_id") AND (("p"."role" = 'admin'::"text") OR ("p"."can_manage_carline" = true))))))));


--
-- Name: carline_bus_arrivals; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."carline_bus_arrivals" ENABLE ROW LEVEL SECURITY;

--
-- Name: carline_bus_arrivals carline_bus_arrivals_insert; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "carline_bus_arrivals_insert" ON "public"."carline_bus_arrivals" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."school_id" = "carline_bus_arrivals"."school_id") AND ("p"."status" = 'active'::"text") AND (("p"."is_superadmin" = true) OR ("p"."can_manage_carline" = true))))));


--
-- Name: carline_bus_arrivals carline_bus_arrivals_select; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "carline_bus_arrivals_select" ON "public"."carline_bus_arrivals" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."school_id" = "carline_bus_arrivals"."school_id") AND ("p"."status" = 'active'::"text") AND (("p"."is_superadmin" = true) OR ("p"."can_view_carline" = true))))));


--
-- Name: carline_bus_arrivals carline_bus_arrivals_update; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "carline_bus_arrivals_update" ON "public"."carline_bus_arrivals" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."status" = 'active'::"text") AND ("p"."school_id" = "carline_bus_arrivals"."school_id") AND (("p"."is_superadmin" = true) OR ("p"."can_manage_carline" = true))))));


--
-- Name: carline_calls; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."carline_calls" ENABLE ROW LEVEL SECURITY;

--
-- Name: carline_calls carline_calls_delete_admin; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "carline_calls_delete_admin" ON "public"."carline_calls" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."status" = 'active'::"text") AND (("p"."is_superadmin" = true) OR (("p"."role" = 'admin'::"text") AND ("p"."school_id" = "carline_calls"."school_id")) OR (("p"."can_manage_carline" = true) AND ("p"."school_id" = "carline_calls"."school_id")))))));


--
-- Name: carline_calls carline_calls_insert_admin; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "carline_calls_insert_admin" ON "public"."carline_calls" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."status" = 'active'::"text") AND (("p"."is_superadmin" = true) OR (("p"."role" = 'admin'::"text") AND ("p"."school_id" = "carline_calls"."school_id")) OR (("p"."can_manage_carline" = true) AND ("p"."school_id" = "carline_calls"."school_id")))))));


--
-- Name: carline_calls carline_calls_read_same_school; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "carline_calls_read_same_school" ON "public"."carline_calls" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."status" = 'active'::"text") AND (("p"."is_superadmin" = true) OR ("p"."school_id" = "carline_calls"."school_id"))))));


--
-- Name: carline_calls carline_calls_update_admin; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "carline_calls_update_admin" ON "public"."carline_calls" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."status" = 'active'::"text") AND (("p"."is_superadmin" = true) OR (("p"."role" = 'admin'::"text") AND ("p"."school_id" = "carline_calls"."school_id")) OR (("p"."can_manage_carline" = true) AND ("p"."school_id" = "carline_calls"."school_id")))))));


--
-- Name: carline_events; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."carline_events" ENABLE ROW LEVEL SECURITY;

--
-- Name: carline_events carline_events_delete_admin; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "carline_events_delete_admin" ON "public"."carline_events" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."status" = 'active'::"text") AND (("p"."is_superadmin" = true) OR (("p"."role" = 'admin'::"text") AND ("p"."school_id" = "carline_events"."school_id")) OR (("p"."can_manage_carline" = true) AND ("p"."school_id" = "carline_events"."school_id")))))));


--
-- Name: carline_events carline_events_insert_admin; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "carline_events_insert_admin" ON "public"."carline_events" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."status" = 'active'::"text") AND (("p"."is_superadmin" = true) OR (("p"."role" = 'admin'::"text") AND ("p"."school_id" = "carline_events"."school_id")) OR (("p"."can_manage_carline" = true) AND ("p"."school_id" = "carline_events"."school_id")))))));


--
-- Name: carline_events carline_events_read_same_school; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "carline_events_read_same_school" ON "public"."carline_events" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."status" = 'active'::"text") AND (("p"."is_superadmin" = true) OR ("p"."school_id" = "carline_events"."school_id"))))));


--
-- Name: carline_events carline_events_update_admin; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "carline_events_update_admin" ON "public"."carline_events" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."status" = 'active'::"text") AND (("p"."is_superadmin" = true) OR (("p"."role" = 'admin'::"text") AND ("p"."school_id" = "carline_events"."school_id")) OR (("p"."can_manage_carline" = true) AND ("p"."school_id" = "carline_events"."school_id")))))));


--
-- Name: carline_pickup_groups; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."carline_pickup_groups" ENABLE ROW LEVEL SECURITY;

--
-- Name: carline_pickup_groups carline_pickup_groups_manage; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "carline_pickup_groups_manage" ON "public"."carline_pickup_groups" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."status" = 'active'::"text") AND ("p"."school_id" = "carline_pickup_groups"."school_id") AND ("p"."can_manage_carline" OR "p"."is_superadmin")))));


--
-- Name: carline_pickup_groups carline_pickup_groups_read; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "carline_pickup_groups_read" ON "public"."carline_pickup_groups" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."status" = 'active'::"text") AND ("p"."school_id" = "carline_pickup_groups"."school_id") AND ("p"."can_view_carline" OR "p"."can_manage_carline" OR "p"."is_superadmin")))));


--
-- Name: carline_tags; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."carline_tags" ENABLE ROW LEVEL SECURITY;

--
-- Name: carline_tags carline_tags_admin_write; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "carline_tags_admin_write" ON "public"."carline_tags" USING ((EXISTS ( SELECT 1
   FROM ("public"."profiles" "p"
     JOIN "public"."carpools" "c" ON (("c"."id" = "carline_tags"."carpool_id")))
  WHERE (("p"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."status" = 'active'::"text") AND (("p"."is_superadmin" = true) OR (("p"."can_manage_carpools" = true) AND ("p"."school_id" = "c"."school_id")))))));


--
-- Name: carline_tags carline_tags_read; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "carline_tags_read" ON "public"."carline_tags" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM ("public"."profiles" "p"
     JOIN "public"."carpools" "c" ON (("c"."id" = "carline_tags"."carpool_id")))
  WHERE (("p"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."status" = 'active'::"text") AND ("p"."school_id" = "c"."school_id") AND (("p"."can_view_carline" = true) OR ("p"."can_manage_carline" = true) OR ("p"."can_manage_carpools" = true) OR ("p"."is_superadmin" = true))))));


--
-- Name: carpool_students; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."carpool_students" ENABLE ROW LEVEL SECURITY;

--
-- Name: carpool_students carpool_students_admin_write; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "carpool_students_admin_write" ON "public"."carpool_students" USING ((EXISTS ( SELECT 1
   FROM ("public"."profiles" "p"
     JOIN "public"."carpools" "c" ON (("c"."id" = "carpool_students"."carpool_id")))
  WHERE (("p"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."status" = 'active'::"text") AND (("p"."is_superadmin" = true) OR (("p"."can_manage_carpools" = true) AND ("p"."school_id" = "c"."school_id")))))));


--
-- Name: carpool_students carpool_students_read; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "carpool_students_read" ON "public"."carpool_students" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM ("public"."profiles" "p"
     JOIN "public"."carpools" "c" ON (("c"."id" = "carpool_students"."carpool_id")))
  WHERE (("p"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."status" = 'active'::"text") AND ("p"."school_id" = "c"."school_id") AND (("p"."can_view_carline" = true) OR ("p"."can_manage_carline" = true) OR ("p"."can_manage_carpools" = true) OR ("p"."is_superadmin" = true))))));


--
-- Name: carpools; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."carpools" ENABLE ROW LEVEL SECURITY;

--
-- Name: carpools carpools_admin_write; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "carpools_admin_write" ON "public"."carpools" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."status" = 'active'::"text") AND (("p"."is_superadmin" = true) OR (("p"."can_manage_carpools" = true) AND ("p"."school_id" = "carpools"."school_id")))))));


--
-- Name: carpools carpools_read; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "carpools_read" ON "public"."carpools" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."status" = 'active'::"text") AND ("p"."school_id" = "carpools"."school_id") AND (("p"."can_view_carline" = true) OR ("p"."can_manage_carline" = true) OR ("p"."can_manage_carpools" = true) OR ("p"."is_superadmin" = true))))));


--
-- Name: compliance_report_grants compliance managers manage grants; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "compliance managers manage grants" ON "public"."compliance_report_grants" USING (("school_id" IN ( SELECT "p"."school_id"
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."can_manage_compliance" = true)))));


--
-- Name: compliance_agreements; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."compliance_agreements" ENABLE ROW LEVEL SECURITY;

--
-- Name: compliance_agreements compliance_agreements_ft_read; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "compliance_agreements_ft_read" ON "public"."compliance_agreements" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."school_id" = "compliance_agreements"."school_id") AND (("p"."can_manage_field_trips" = true) OR ("p"."is_superadmin" = true) OR (EXISTS ( SELECT 1
           FROM ("public"."field_trip_managers" "m"
             JOIN "public"."field_trips" "ft" ON (("ft"."id" = "m"."field_trip_id")))
          WHERE (("m"."profile_id" = "p"."id") AND ("ft"."school_id" = "compliance_agreements"."school_id")))))))));


--
-- Name: compliance_agreements compliance_agreements_manager; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "compliance_agreements_manager" ON "public"."compliance_agreements" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."school_id" = "compliance_agreements"."school_id") AND (("p"."can_manage_compliance" = true) OR ("p"."is_superadmin" = true))))));


--
-- Name: compliance_bg_check_requests; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."compliance_bg_check_requests" ENABLE ROW LEVEL SECURITY;

--
-- Name: compliance_form_links; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."compliance_form_links" ENABLE ROW LEVEL SECURITY;

--
-- Name: compliance_form_links compliance_form_links_manager; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "compliance_form_links_manager" ON "public"."compliance_form_links" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."school_id" = "compliance_form_links"."school_id") AND (("p"."can_manage_compliance" = true) OR ("p"."is_superadmin" = true))))));


--
-- Name: compliance_form_templates; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."compliance_form_templates" ENABLE ROW LEVEL SECURITY;

--
-- Name: compliance_form_templates compliance_form_templates_ft_read; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "compliance_form_templates_ft_read" ON "public"."compliance_form_templates" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."school_id" = "compliance_form_templates"."school_id") AND (("p"."can_manage_field_trips" = true) OR ("p"."is_superadmin" = true) OR (EXISTS ( SELECT 1
           FROM ("public"."field_trip_managers" "m"
             JOIN "public"."field_trips" "ft" ON (("ft"."id" = "m"."field_trip_id")))
          WHERE (("m"."profile_id" = "p"."id") AND ("ft"."school_id" = "compliance_form_templates"."school_id")))))))));


--
-- Name: compliance_form_templates compliance_form_templates_manager; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "compliance_form_templates_manager" ON "public"."compliance_form_templates" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."school_id" = "compliance_form_templates"."school_id") AND (("p"."can_manage_compliance" = true) OR ("p"."is_superadmin" = true))))));


--
-- Name: compliance_report_grants; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."compliance_report_grants" ENABLE ROW LEVEL SECURITY;

--
-- Name: compliance_volunteers; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."compliance_volunteers" ENABLE ROW LEVEL SECURITY;

--
-- Name: compliance_volunteers compliance_volunteers_ft_read; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "compliance_volunteers_ft_read" ON "public"."compliance_volunteers" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."school_id" = "compliance_volunteers"."school_id") AND (("p"."can_manage_field_trips" = true) OR ("p"."is_superadmin" = true) OR (EXISTS ( SELECT 1
           FROM ("public"."field_trip_managers" "m"
             JOIN "public"."field_trips" "ft" ON (("ft"."id" = "m"."field_trip_id")))
          WHERE (("m"."profile_id" = "p"."id") AND ("ft"."school_id" = "compliance_volunteers"."school_id")))))))));


--
-- Name: compliance_volunteers compliance_volunteers_manager; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "compliance_volunteers_manager" ON "public"."compliance_volunteers" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."school_id" = "compliance_volunteers"."school_id") AND (("p"."can_manage_compliance" = true) OR ("p"."is_superadmin" = true))))));


--
-- Name: employee_pto_policies; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."employee_pto_policies" ENABLE ROW LEVEL SECURITY;

--
-- Name: pto_requests employee_self_create_pto; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "employee_self_create_pto" ON "public"."pto_requests" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM ("public"."profiles" "p"
     JOIN "public"."employees" "e" ON (("e"."user_id" = "p"."user_id")))
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."school_id" = "pto_requests"."school_id") AND ("e"."id" = "pto_requests"."employee_id") AND ("p"."status" = 'active'::"text")))));


--
-- Name: employees; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."employees" ENABLE ROW LEVEL SECURITY;

--
-- Name: employees employees_delete_admin; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "employees_delete_admin" ON "public"."employees" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."status" = 'active'::"text") AND (("p"."is_superadmin" = true) OR (("p"."role" = 'admin'::"text") AND ("p"."school_id" = "employees"."school_id")) OR (("p"."can_manage_staff" = true) AND ("p"."school_id" = "employees"."school_id")))))));


--
-- Name: employees employees_insert_admin; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "employees_insert_admin" ON "public"."employees" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."status" = 'active'::"text") AND (("p"."is_superadmin" = true) OR ("p"."role" = 'admin'::"text"))))));


--
-- Name: employees employees_insert_manage_staff; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "employees_insert_manage_staff" ON "public"."employees" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."status" = 'active'::"text") AND ("p"."school_id" = "employees"."school_id") AND ("p"."can_manage_staff" = true)))));


--
-- Name: employees employees_read_same_school; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "employees_read_same_school" ON "public"."employees" FOR SELECT USING ("public"."current_user_is_active_in_school"("school_id"));


--
-- Name: employees employees_sub_manager_read_school; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "employees_sub_manager_read_school" ON "public"."employees" FOR SELECT TO "authenticated" USING ("public"."current_user_can_manage_substitutes"("school_id"));


--
-- Name: employees employees_update_admin; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "employees_update_admin" ON "public"."employees" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."status" = 'active'::"text") AND (("p"."is_superadmin" = true) OR (("p"."role" = 'admin'::"text") AND ("p"."school_id" = "employees"."school_id"))))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."status" = 'active'::"text") AND (("p"."is_superadmin" = true) OR (("p"."role" = 'admin'::"text") AND ("p"."school_id" = "employees"."school_id")))))));


--
-- Name: employees employees_update_manage_staff; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "employees_update_manage_staff" ON "public"."employees" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."status" = 'active'::"text") AND ("p"."school_id" = "employees"."school_id") AND ("p"."can_manage_staff" = true))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."status" = 'active'::"text") AND ("p"."school_id" = "employees"."school_id") AND ("p"."can_manage_staff" = true)))));


--
-- Name: families; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."families" ENABLE ROW LEVEL SECURITY;

--
-- Name: families families_delete_admin; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "families_delete_admin" ON "public"."families" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."status" = 'active'::"text") AND (("p"."is_superadmin" = true) OR (("p"."role" = 'admin'::"text") AND ("p"."school_id" = "families"."school_id")) OR (("p"."can_manage_families" = true) AND ("p"."school_id" = "families"."school_id")))))));


--
-- Name: families families_insert_admin; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "families_insert_admin" ON "public"."families" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."status" = 'active'::"text") AND (("p"."is_superadmin" = true) OR ("p"."role" = 'admin'::"text"))))));


--
-- Name: families families_insert_manage_families; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "families_insert_manage_families" ON "public"."families" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."status" = 'active'::"text") AND ("p"."school_id" = "families"."school_id") AND ("p"."can_manage_families" = true)))));


--
-- Name: families families_read_same_school; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "families_read_same_school" ON "public"."families" FOR SELECT USING ("public"."current_user_is_active_in_school"("school_id"));


--
-- Name: families families_update_admin; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "families_update_admin" ON "public"."families" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."status" = 'active'::"text") AND (("p"."is_superadmin" = true) OR (("p"."role" = 'admin'::"text") AND ("p"."school_id" = "families"."school_id"))))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."status" = 'active'::"text") AND (("p"."is_superadmin" = true) OR (("p"."role" = 'admin'::"text") AND ("p"."school_id" = "families"."school_id")))))));


--
-- Name: families families_update_manage_families; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "families_update_manage_families" ON "public"."families" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."status" = 'active'::"text") AND ("p"."school_id" = "families"."school_id") AND ("p"."can_manage_families" = true))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."status" = 'active'::"text") AND ("p"."school_id" = "families"."school_id") AND ("p"."can_manage_families" = true)))));


--
-- Name: field_trip_chaperones; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."field_trip_chaperones" ENABLE ROW LEVEL SECURITY;

--
-- Name: field_trip_managers; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."field_trip_managers" ENABLE ROW LEVEL SECURITY;

--
-- Name: field_trip_payment_log; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."field_trip_payment_log" ENABLE ROW LEVEL SECURITY;

--
-- Name: field_trip_payments; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."field_trip_payments" ENABLE ROW LEVEL SECURITY;

--
-- Name: field_trip_students; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."field_trip_students" ENABLE ROW LEVEL SECURITY;

--
-- Name: field_trip_vehicle_assignments; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."field_trip_vehicle_assignments" ENABLE ROW LEVEL SECURITY;

--
-- Name: field_trips; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."field_trips" ENABLE ROW LEVEL SECURITY;

--
-- Name: field_trips ft_delete; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "ft_delete" ON "public"."field_trips" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."school_id" = "field_trips"."school_id") AND (("p"."can_manage_field_trips" = true) OR ("p"."is_superadmin" = true))))));


--
-- Name: field_trips ft_insert; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "ft_insert" ON "public"."field_trips" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."school_id" = "field_trips"."school_id") AND ("p"."can_login" = true)))));


--
-- Name: field_trips ft_select; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "ft_select" ON "public"."field_trips" FOR SELECT USING ("public"."current_user_can_view_trip"("school_id", "id", "created_by_profile_id"));


--
-- Name: field_trips ft_update; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "ft_update" ON "public"."field_trips" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."school_id" = "field_trips"."school_id") AND (("p"."can_manage_field_trips" = true) OR ("p"."is_superadmin" = true) OR (EXISTS ( SELECT 1
           FROM "public"."field_trip_managers" "m"
          WHERE (("m"."field_trip_id" = "field_trips"."id") AND ("m"."profile_id" = "p"."id")))))))));


--
-- Name: field_trip_chaperones ftc_all; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "ftc_all" ON "public"."field_trip_chaperones" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."school_id" = "field_trip_chaperones"."school_id") AND (("p"."can_manage_field_trips" = true) OR ("p"."is_superadmin" = true) OR (EXISTS ( SELECT 1
           FROM "public"."field_trip_managers" "m"
          WHERE (("m"."field_trip_id" = "field_trip_chaperones"."field_trip_id") AND ("m"."profile_id" = "p"."id")))))))));


--
-- Name: field_trip_managers ftm_delete; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "ftm_delete" ON "public"."field_trip_managers" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND (("p"."is_superadmin" = true) OR ("p"."school_id" = "public"."ft_get_school_id"("field_trip_managers"."field_trip_id"))) AND (("p"."can_manage_field_trips" = true) OR ("p"."is_superadmin" = true) OR "public"."ft_is_manager"("field_trip_managers"."field_trip_id", "p"."id"))))));


--
-- Name: field_trip_managers ftm_insert; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "ftm_insert" ON "public"."field_trip_managers" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND (("p"."is_superadmin" = true) OR ("p"."school_id" = "public"."ft_get_school_id"("field_trip_managers"."field_trip_id"))) AND (("p"."can_manage_field_trips" = true) OR ("p"."is_superadmin" = true) OR "public"."ft_is_manager"("field_trip_managers"."field_trip_id", "p"."id") OR ("field_trip_managers"."profile_id" = "p"."id"))))));


--
-- Name: field_trip_managers ftm_select; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "ftm_select" ON "public"."field_trip_managers" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND (("p"."is_superadmin" = true) OR ("p"."school_id" = "public"."ft_get_school_id"("field_trip_managers"."field_trip_id")))))));


--
-- Name: field_trip_managers ftm_update; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "ftm_update" ON "public"."field_trip_managers" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND (("p"."is_superadmin" = true) OR ("p"."school_id" = "public"."ft_get_school_id"("field_trip_managers"."field_trip_id"))) AND (("p"."can_manage_field_trips" = true) OR ("p"."is_superadmin" = true) OR "public"."ft_is_manager"("field_trip_managers"."field_trip_id", "p"."id"))))));


--
-- Name: field_trip_payments ftp_delete; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "ftp_delete" ON "public"."field_trip_payments" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND (("p"."is_superadmin" = true) OR (("p"."school_id" = "public"."ft_get_school_id"("field_trip_payments"."field_trip_id")) AND (("p"."can_manage_field_trips" = true) OR "public"."ft_is_manager"("field_trip_payments"."field_trip_id", "p"."id"))))))));


--
-- Name: field_trip_payments ftp_insert; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "ftp_insert" ON "public"."field_trip_payments" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND (("p"."is_superadmin" = true) OR (("p"."school_id" = "public"."ft_get_school_id"("field_trip_payments"."field_trip_id")) AND (("p"."can_manage_field_trips" = true) OR "public"."ft_is_manager"("field_trip_payments"."field_trip_id", "p"."id"))))))));


--
-- Name: field_trip_payments ftp_select; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "ftp_select" ON "public"."field_trip_payments" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND (("p"."is_superadmin" = true) OR (("p"."school_id" = "public"."ft_get_school_id"("field_trip_payments"."field_trip_id")) AND (("p"."can_manage_field_trips" = true) OR "public"."ft_is_manager"("field_trip_payments"."field_trip_id", "p"."id"))))))));


--
-- Name: field_trip_payments ftp_update; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "ftp_update" ON "public"."field_trip_payments" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND (("p"."is_superadmin" = true) OR (("p"."school_id" = "public"."ft_get_school_id"("field_trip_payments"."field_trip_id")) AND (("p"."can_manage_field_trips" = true) OR "public"."ft_is_manager"("field_trip_payments"."field_trip_id", "p"."id"))))))));


--
-- Name: field_trip_payment_log ftpl_insert; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "ftpl_insert" ON "public"."field_trip_payment_log" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM ("public"."field_trip_payments" "ftp"
     JOIN "public"."profiles" "p" ON (("p"."user_id" = "auth"."uid"())))
  WHERE (("ftp"."id" = "field_trip_payment_log"."payment_id") AND (("p"."is_superadmin" = true) OR (("p"."school_id" = "public"."ft_get_school_id"("ftp"."field_trip_id")) AND (("p"."can_manage_field_trips" = true) OR "public"."ft_is_manager"("ftp"."field_trip_id", "p"."id"))))))));


--
-- Name: field_trip_payment_log ftpl_select; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "ftpl_select" ON "public"."field_trip_payment_log" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM ("public"."field_trip_payments" "ftp"
     JOIN "public"."profiles" "p" ON (("p"."user_id" = "auth"."uid"())))
  WHERE (("ftp"."id" = "field_trip_payment_log"."payment_id") AND (("p"."is_superadmin" = true) OR (("p"."school_id" = "public"."ft_get_school_id"("ftp"."field_trip_id")) AND (("p"."can_manage_field_trips" = true) OR "public"."ft_is_manager"("ftp"."field_trip_id", "p"."id"))))))));


--
-- Name: field_trip_students fts_all; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "fts_all" ON "public"."field_trip_students" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."school_id" = "field_trip_students"."school_id") AND (("p"."can_manage_field_trips" = true) OR ("p"."is_superadmin" = true) OR (EXISTS ( SELECT 1
           FROM "public"."field_trip_managers" "m"
          WHERE (("m"."field_trip_id" = "field_trip_students"."field_trip_id") AND ("m"."profile_id" = "p"."id")))))))));


--
-- Name: field_trip_vehicle_assignments ftva_delete; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "ftva_delete" ON "public"."field_trip_vehicle_assignments" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND (("p"."is_superadmin" = true) OR (("p"."school_id" = "public"."ft_get_school_id"("field_trip_vehicle_assignments"."field_trip_id")) AND (("p"."can_manage_field_trips" = true) OR "public"."ft_is_manager"("field_trip_vehicle_assignments"."field_trip_id", "p"."id"))))))));


--
-- Name: field_trip_vehicle_assignments ftva_insert; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "ftva_insert" ON "public"."field_trip_vehicle_assignments" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND (("p"."is_superadmin" = true) OR (("p"."school_id" = "public"."ft_get_school_id"("field_trip_vehicle_assignments"."field_trip_id")) AND (("p"."can_manage_field_trips" = true) OR "public"."ft_is_manager"("field_trip_vehicle_assignments"."field_trip_id", "p"."id"))))))));


--
-- Name: field_trip_vehicle_assignments ftva_select; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "ftva_select" ON "public"."field_trip_vehicle_assignments" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND (("p"."is_superadmin" = true) OR (("p"."school_id" = "public"."ft_get_school_id"("field_trip_vehicle_assignments"."field_trip_id")) AND (("p"."can_manage_field_trips" = true) OR "public"."ft_is_manager"("field_trip_vehicle_assignments"."field_trip_id", "p"."id"))))))));


--
-- Name: field_trip_vehicle_assignments ftva_update; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "ftva_update" ON "public"."field_trip_vehicle_assignments" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND (("p"."is_superadmin" = true) OR (("p"."school_id" = "public"."ft_get_school_id"("field_trip_vehicle_assignments"."field_trip_id")) AND (("p"."can_manage_field_trips" = true) OR "public"."ft_is_manager"("field_trip_vehicle_assignments"."field_trip_id", "p"."id"))))))));


--
-- Name: grade_check; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."grade_check" ENABLE ROW LEVEL SECURITY;

--
-- Name: compliance_report_grants grantees read own grants; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "grantees read own grants" ON "public"."compliance_report_grants" FOR SELECT USING (("grantee_id" IN ( SELECT "p"."id"
   FROM "public"."profiles" "p"
  WHERE ("p"."user_id" = "auth"."uid"()))));


--
-- Name: guardian_intake_campaigns; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."guardian_intake_campaigns" ENABLE ROW LEVEL SECURITY;

--
-- Name: guardian_intake_submissions; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."guardian_intake_submissions" ENABLE ROW LEVEL SECURITY;

--
-- Name: guardians; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."guardians" ENABLE ROW LEVEL SECURITY;

--
-- Name: guardians guardians_read_same_school; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "guardians_read_same_school" ON "public"."guardians" FOR SELECT USING ("public"."current_user_is_active_in_school"("school_id"));


--
-- Name: ic_data_gaps; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."ic_data_gaps" ENABLE ROW LEVEL SECURITY;

--
-- Name: ic_data_gaps ic_data_gaps_admin_all; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "ic_data_gaps_admin_all" ON "public"."ic_data_gaps" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."school_id" = "ic_data_gaps"."school_id") AND ("p"."can_bulk_upload" = true))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."school_id" = "ic_data_gaps"."school_id") AND ("p"."can_bulk_upload" = true)))));


--
-- Name: ic_field_diffs; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."ic_field_diffs" ENABLE ROW LEVEL SECURITY;

--
-- Name: ic_field_diffs ic_field_diffs_admin_all; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "ic_field_diffs_admin_all" ON "public"."ic_field_diffs" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."school_id" = "ic_field_diffs"."school_id") AND ("p"."can_bulk_upload" = true))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."school_id" = "ic_field_diffs"."school_id") AND ("p"."can_bulk_upload" = true)))));


--
-- Name: ic_reconciliation_candidates; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."ic_reconciliation_candidates" ENABLE ROW LEVEL SECURITY;

--
-- Name: ic_reconciliation_candidates ic_reconciliation_candidates_admin_all; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "ic_reconciliation_candidates_admin_all" ON "public"."ic_reconciliation_candidates" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."school_id" = "ic_reconciliation_candidates"."school_id") AND ("p"."can_bulk_upload" = true))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."school_id" = "ic_reconciliation_candidates"."school_id") AND ("p"."can_bulk_upload" = true)))));


--
-- Name: ic_sync_field_settings; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."ic_sync_field_settings" ENABLE ROW LEVEL SECURITY;

--
-- Name: ic_sync_field_settings ic_sync_field_settings_admin_all; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "ic_sync_field_settings_admin_all" ON "public"."ic_sync_field_settings" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."school_id" = "ic_sync_field_settings"."school_id") AND ("p"."can_bulk_upload" = true))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."school_id" = "ic_sync_field_settings"."school_id") AND ("p"."can_bulk_upload" = true)))));


--
-- Name: ic_sync_runs; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."ic_sync_runs" ENABLE ROW LEVEL SECURITY;

--
-- Name: ic_sync_runs ic_sync_runs_admin_select; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "ic_sync_runs_admin_select" ON "public"."ic_sync_runs" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."school_id" = "ic_sync_runs"."school_id") AND ("p"."can_access_admin" = true)))));


--
-- Name: guardian_intake_campaigns intake_campaigns_admin_all; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "intake_campaigns_admin_all" ON "public"."guardian_intake_campaigns" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."school_id" = "guardian_intake_campaigns"."school_id") AND ("p"."can_manage_guardians" OR "p"."can_manage_families" OR "p"."is_superadmin")))));


--
-- Name: guardian_intake_campaigns intake_campaigns_anon_read; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "intake_campaigns_anon_read" ON "public"."guardian_intake_campaigns" FOR SELECT TO "anon" USING (("status" = 'active'::"text"));


--
-- Name: guardian_intake_campaigns intake_campaigns_staff_read; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "intake_campaigns_staff_read" ON "public"."guardian_intake_campaigns" FOR SELECT USING ((("status" = 'active'::"text") AND (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."school_id" = "guardian_intake_campaigns"."school_id") AND ("p"."can_login" = true))))));


--
-- Name: guardian_intake_submissions intake_submissions_admin_all; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "intake_submissions_admin_all" ON "public"."guardian_intake_submissions" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."school_id" = "guardian_intake_submissions"."school_id") AND ("p"."can_manage_guardians" OR "p"."can_manage_families" OR "p"."is_superadmin")))));


--
-- Name: guardian_intake_submissions intake_submissions_anon_insert; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "intake_submissions_anon_insert" ON "public"."guardian_intake_submissions" FOR INSERT TO "anon" WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."guardian_intake_campaigns" "c"
  WHERE (("c"."id" = "guardian_intake_submissions"."campaign_id") AND ("c"."school_id" = "guardian_intake_submissions"."school_id") AND ("c"."status" = 'active'::"text")))));


--
-- Name: inventory_assignments; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."inventory_assignments" ENABLE ROW LEVEL SECURITY;

--
-- Name: inventory_assignments inventory_assignments_all; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "inventory_assignments_all" ON "public"."inventory_assignments" USING ((EXISTS ( SELECT 1
   FROM ("public"."inventory_lists" "l"
     JOIN "public"."profiles" "p" ON (("p"."user_id" = "auth"."uid"())))
  WHERE (("l"."id" = "inventory_assignments"."list_id") AND ("p"."status" = 'active'::"text") AND (("p"."is_superadmin" = true) OR (("p"."school_id" = "l"."school_id") AND (("p"."role" = 'admin'::"text") OR ("p"."can_manage_inventory" = true) OR ("p"."id" = "l"."owner_profile_id")))))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM ("public"."inventory_lists" "l"
     JOIN "public"."profiles" "p" ON (("p"."user_id" = "auth"."uid"())))
  WHERE (("l"."id" = "inventory_assignments"."list_id") AND ("p"."status" = 'active'::"text") AND (("p"."is_superadmin" = true) OR (("p"."school_id" = "l"."school_id") AND (("p"."role" = 'admin'::"text") OR ("p"."can_manage_inventory" = true) OR ("p"."id" = "l"."owner_profile_id"))))))));


--
-- Name: inventory_list_items; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."inventory_list_items" ENABLE ROW LEVEL SECURITY;

--
-- Name: inventory_list_items inventory_list_items_all; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "inventory_list_items_all" ON "public"."inventory_list_items" USING ((EXISTS ( SELECT 1
   FROM ("public"."inventory_lists" "l"
     JOIN "public"."profiles" "p" ON (("p"."user_id" = "auth"."uid"())))
  WHERE (("l"."id" = "inventory_list_items"."list_id") AND ("p"."status" = 'active'::"text") AND (("p"."is_superadmin" = true) OR (("p"."school_id" = "l"."school_id") AND (("p"."role" = 'admin'::"text") OR ("p"."can_manage_inventory" = true) OR ("p"."id" = "l"."owner_profile_id")))))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM ("public"."inventory_lists" "l"
     JOIN "public"."profiles" "p" ON (("p"."user_id" = "auth"."uid"())))
  WHERE (("l"."id" = "inventory_list_items"."list_id") AND ("p"."status" = 'active'::"text") AND (("p"."is_superadmin" = true) OR (("p"."school_id" = "l"."school_id") AND (("p"."role" = 'admin'::"text") OR ("p"."can_manage_inventory" = true) OR ("p"."id" = "l"."owner_profile_id"))))))));


--
-- Name: inventory_list_members; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."inventory_list_members" ENABLE ROW LEVEL SECURITY;

--
-- Name: inventory_list_members inventory_list_members_all; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "inventory_list_members_all" ON "public"."inventory_list_members" USING ((EXISTS ( SELECT 1
   FROM ("public"."inventory_lists" "l"
     JOIN "public"."profiles" "p" ON (("p"."user_id" = "auth"."uid"())))
  WHERE (("l"."id" = "inventory_list_members"."list_id") AND ("p"."status" = 'active'::"text") AND (("p"."is_superadmin" = true) OR (("p"."school_id" = "l"."school_id") AND (("p"."role" = 'admin'::"text") OR ("p"."can_manage_inventory" = true) OR ("p"."id" = "l"."owner_profile_id")))))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM ("public"."inventory_lists" "l"
     JOIN "public"."profiles" "p" ON (("p"."user_id" = "auth"."uid"())))
  WHERE (("l"."id" = "inventory_list_members"."list_id") AND ("p"."status" = 'active'::"text") AND (("p"."is_superadmin" = true) OR (("p"."school_id" = "l"."school_id") AND (("p"."role" = 'admin'::"text") OR ("p"."can_manage_inventory" = true) OR ("p"."id" = "l"."owner_profile_id"))))))));


--
-- Name: inventory_lists; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."inventory_lists" ENABLE ROW LEVEL SECURITY;

--
-- Name: inventory_lists inventory_lists_all; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "inventory_lists_all" ON "public"."inventory_lists" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."status" = 'active'::"text") AND (("p"."is_superadmin" = true) OR (("p"."school_id" = "inventory_lists"."school_id") AND (("p"."role" = 'admin'::"text") OR ("p"."can_manage_inventory" = true) OR ("p"."id" = "inventory_lists"."owner_profile_id")))))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."status" = 'active'::"text") AND (("p"."is_superadmin" = true) OR (("p"."school_id" = "inventory_lists"."school_id") AND (("p"."role" = 'admin'::"text") OR ("p"."can_manage_inventory" = true) OR ("p"."id" = "inventory_lists"."owner_profile_id"))))))));


--
-- Name: license_alert_log; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."license_alert_log" ENABLE ROW LEVEL SECURITY;

--
-- Name: permission_audit_log pal_select; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "pal_select" ON "public"."permission_audit_log" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."school_id" = "permission_audit_log"."school_id") AND ("p"."is_superadmin" OR "p"."can_manage_access")))));


--
-- Name: permission_audit_log; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."permission_audit_log" ENABLE ROW LEVEL SECURITY;

--
-- Name: placement_assignments; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."placement_assignments" ENABLE ROW LEVEL SECURITY;

--
-- Name: placement_assignments placement_assignments_all; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "placement_assignments_all" ON "public"."placement_assignments" USING ((EXISTS ( SELECT 1
   FROM ("public"."profiles" "p"
     JOIN "public"."placement_sessions" "ps" ON (("ps"."id" = "placement_assignments"."session_id")))
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."status" = 'active'::"text") AND (("p"."is_superadmin" = true) OR ("p"."school_id" = "ps"."school_id"))))));


--
-- Name: placement_assignments placement_assignments_read; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "placement_assignments_read" ON "public"."placement_assignments" FOR SELECT USING (("session_id" IN ( SELECT "placement_sessions"."id"
   FROM "public"."placement_sessions"
  WHERE ("placement_sessions"."school_id" = ( SELECT "profiles"."school_id"
           FROM "public"."profiles"
          WHERE ("profiles"."user_id" = "auth"."uid"())
         LIMIT 1)))));


--
-- Name: placement_assignments placement_assignments_write; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "placement_assignments_write" ON "public"."placement_assignments" USING ((("session_id" IN ( SELECT "placement_sessions"."id"
   FROM "public"."placement_sessions"
  WHERE ("placement_sessions"."school_id" = ( SELECT "profiles"."school_id"
           FROM "public"."profiles"
          WHERE ("profiles"."user_id" = "auth"."uid"())
         LIMIT 1)))) AND ((( SELECT "profiles"."is_superadmin"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"())
 LIMIT 1) = true) OR (( SELECT "profiles"."role"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"())
 LIMIT 1) = 'admin'::"text") OR (( SELECT "profiles"."can_manage_placement"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"())
 LIMIT 1) = true)))) WITH CHECK ((("session_id" IN ( SELECT "placement_sessions"."id"
   FROM "public"."placement_sessions"
  WHERE ("placement_sessions"."school_id" = ( SELECT "profiles"."school_id"
           FROM "public"."profiles"
          WHERE ("profiles"."user_id" = "auth"."uid"())
         LIMIT 1)))) AND ((( SELECT "profiles"."is_superadmin"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"())
 LIMIT 1) = true) OR (( SELECT "profiles"."role"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"())
 LIMIT 1) = 'admin'::"text") OR (( SELECT "profiles"."can_manage_placement"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"())
 LIMIT 1) = true))));


--
-- Name: placement_audit_log; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."placement_audit_log" ENABLE ROW LEVEL SECURITY;

--
-- Name: placement_audit_log placement_audit_log_read; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "placement_audit_log_read" ON "public"."placement_audit_log" FOR SELECT USING (("school_id" = ( SELECT "profiles"."school_id"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"())
 LIMIT 1)));


--
-- Name: placement_audit_log placement_audit_log_write; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "placement_audit_log_write" ON "public"."placement_audit_log" FOR INSERT WITH CHECK ((("school_id" = ( SELECT "profiles"."school_id"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"())
 LIMIT 1)) AND ((( SELECT "profiles"."is_superadmin"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"())
 LIMIT 1) = true) OR (( SELECT "profiles"."role"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"())
 LIMIT 1) = 'admin'::"text") OR (( SELECT "profiles"."can_manage_placement"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"())
 LIMIT 1) = true))));


--
-- Name: placement_flags; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."placement_flags" ENABLE ROW LEVEL SECURITY;

--
-- Name: placement_flags placement_flags_read; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "placement_flags_read" ON "public"."placement_flags" FOR SELECT USING (("school_id" = ( SELECT "profiles"."school_id"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"())
 LIMIT 1)));


--
-- Name: placement_flags placement_flags_write; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "placement_flags_write" ON "public"."placement_flags" USING ((("school_id" = ( SELECT "profiles"."school_id"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"())
 LIMIT 1)) AND ((( SELECT "profiles"."is_superadmin"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"())
 LIMIT 1) = true) OR (( SELECT "profiles"."role"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"())
 LIMIT 1) = 'admin'::"text") OR (( SELECT "profiles"."can_manage_placement"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"())
 LIMIT 1) = true)))) WITH CHECK ((("school_id" = ( SELECT "profiles"."school_id"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"())
 LIMIT 1)) AND ((( SELECT "profiles"."is_superadmin"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"())
 LIMIT 1) = true) OR (( SELECT "profiles"."role"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"())
 LIMIT 1) = 'admin'::"text") OR (( SELECT "profiles"."can_manage_placement"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"())
 LIMIT 1) = true))));


--
-- Name: placement_session_notes; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."placement_session_notes" ENABLE ROW LEVEL SECURITY;

--
-- Name: placement_session_notes placement_session_notes_delete; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "placement_session_notes_delete" ON "public"."placement_session_notes" FOR DELETE USING ((("session_id" IN ( SELECT "placement_sessions"."id"
   FROM "public"."placement_sessions"
  WHERE ("placement_sessions"."school_id" = ( SELECT "profiles"."school_id"
           FROM "public"."profiles"
          WHERE ("profiles"."user_id" = "auth"."uid"())
         LIMIT 1)))) AND (("author_id" = ( SELECT "profiles"."id"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"())
 LIMIT 1)) OR (( SELECT "profiles"."is_superadmin"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"())
 LIMIT 1) = true) OR (( SELECT "profiles"."role"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"())
 LIMIT 1) = 'admin'::"text"))));


--
-- Name: placement_session_notes placement_session_notes_insert; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "placement_session_notes_insert" ON "public"."placement_session_notes" FOR INSERT WITH CHECK ((("session_id" IN ( SELECT "placement_sessions"."id"
   FROM "public"."placement_sessions"
  WHERE ("placement_sessions"."school_id" = ( SELECT "profiles"."school_id"
           FROM "public"."profiles"
          WHERE ("profiles"."user_id" = "auth"."uid"())
         LIMIT 1)))) AND ("author_id" = ( SELECT "profiles"."id"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"())
 LIMIT 1)) AND ((( SELECT "profiles"."is_superadmin"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"())
 LIMIT 1) = true) OR (( SELECT "profiles"."role"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"())
 LIMIT 1) = 'admin'::"text") OR (( SELECT "profiles"."can_manage_placement"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"())
 LIMIT 1) = true))));


--
-- Name: placement_session_notes placement_session_notes_read; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "placement_session_notes_read" ON "public"."placement_session_notes" FOR SELECT USING (("session_id" IN ( SELECT "placement_sessions"."id"
   FROM "public"."placement_sessions"
  WHERE ("placement_sessions"."school_id" = ( SELECT "profiles"."school_id"
           FROM "public"."profiles"
          WHERE ("profiles"."user_id" = "auth"."uid"())
         LIMIT 1)))));


--
-- Name: placement_session_teachers; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."placement_session_teachers" ENABLE ROW LEVEL SECURITY;

--
-- Name: placement_session_teachers placement_session_teachers_read; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "placement_session_teachers_read" ON "public"."placement_session_teachers" FOR SELECT USING (("session_id" IN ( SELECT "placement_sessions"."id"
   FROM "public"."placement_sessions"
  WHERE ("placement_sessions"."school_id" = ( SELECT "profiles"."school_id"
           FROM "public"."profiles"
          WHERE ("profiles"."user_id" = "auth"."uid"())
         LIMIT 1)))));


--
-- Name: placement_session_teachers placement_session_teachers_write; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "placement_session_teachers_write" ON "public"."placement_session_teachers" USING ((("session_id" IN ( SELECT "placement_sessions"."id"
   FROM "public"."placement_sessions"
  WHERE ("placement_sessions"."school_id" = ( SELECT "profiles"."school_id"
           FROM "public"."profiles"
          WHERE ("profiles"."user_id" = "auth"."uid"())
         LIMIT 1)))) AND ((( SELECT "profiles"."is_superadmin"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"())
 LIMIT 1) = true) OR (( SELECT "profiles"."role"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"())
 LIMIT 1) = 'admin'::"text") OR (( SELECT "profiles"."can_manage_placement"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"())
 LIMIT 1) = true)))) WITH CHECK ((("session_id" IN ( SELECT "placement_sessions"."id"
   FROM "public"."placement_sessions"
  WHERE ("placement_sessions"."school_id" = ( SELECT "profiles"."school_id"
           FROM "public"."profiles"
          WHERE ("profiles"."user_id" = "auth"."uid"())
         LIMIT 1)))) AND ((( SELECT "profiles"."is_superadmin"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"())
 LIMIT 1) = true) OR (( SELECT "profiles"."role"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"())
 LIMIT 1) = 'admin'::"text") OR (( SELECT "profiles"."can_manage_placement"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"())
 LIMIT 1) = true))));


--
-- Name: placement_sessions; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."placement_sessions" ENABLE ROW LEVEL SECURITY;

--
-- Name: placement_sessions placement_sessions_read; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "placement_sessions_read" ON "public"."placement_sessions" FOR SELECT USING (("school_id" = ( SELECT "profiles"."school_id"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"())
 LIMIT 1)));


--
-- Name: placement_sessions placement_sessions_write; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "placement_sessions_write" ON "public"."placement_sessions" USING ((("school_id" = ( SELECT "profiles"."school_id"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"())
 LIMIT 1)) AND ((( SELECT "profiles"."is_superadmin"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"())
 LIMIT 1) = true) OR (( SELECT "profiles"."role"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"())
 LIMIT 1) = 'admin'::"text") OR (( SELECT "profiles"."can_manage_placement"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"())
 LIMIT 1) = true)))) WITH CHECK ((("school_id" = ( SELECT "profiles"."school_id"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"())
 LIMIT 1)) AND ((( SELECT "profiles"."is_superadmin"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"())
 LIMIT 1) = true) OR (( SELECT "profiles"."role"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"())
 LIMIT 1) = 'admin'::"text") OR (( SELECT "profiles"."can_manage_placement"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"())
 LIMIT 1) = true))));


--
-- Name: profiles; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;

--
-- Name: profiles profiles_read_self; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "profiles_read_self" ON "public"."profiles" FOR SELECT USING (("user_id" = "auth"."uid"()));


--
-- Name: profiles profiles_update_own; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "profiles_update_own" ON "public"."profiles" FOR UPDATE USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));


--
-- Name: profiles profiles_update_self; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "profiles_update_self" ON "public"."profiles" FOR UPDATE USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));


--
-- Name: pto_ledger pto_admin_insert_ledger; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "pto_admin_insert_ledger" ON "public"."pto_ledger" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."school_id" = "pto_ledger"."school_id") AND ("p"."status" = 'active'::"text") AND (("p"."role" = ANY (ARRAY['admin'::"text", 'hr'::"text"])) OR ("p"."can_adjust_pto" = true))))));


--
-- Name: pto_requests pto_admin_update; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "pto_admin_update" ON "public"."pto_requests" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."school_id" = "pto_requests"."school_id") AND (("p"."role" = ANY (ARRAY['admin'::"text", 'hr'::"text"])) OR ("p"."can_approve_pto" = true))))));


--
-- Name: pto_balances pto_admin_write_balances; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "pto_admin_write_balances" ON "public"."pto_balances" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."school_id" = "pto_balances"."school_id") AND (("p"."role" = ANY (ARRAY['admin'::"text", 'hr'::"text"])) OR ("p"."can_adjust_pto" = true))))));


--
-- Name: pto_balances; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."pto_balances" ENABLE ROW LEVEL SECURITY;

--
-- Name: pto_balances pto_balances_insert_from_ledger; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "pto_balances_insert_from_ledger" ON "public"."pto_balances" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."employees" "e"
  WHERE (("e"."id" = "pto_balances"."employee_id") AND ("e"."school_id" = "pto_balances"."school_id")))));


--
-- Name: pto_balances pto_balances_select_admin; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "pto_balances_select_admin" ON "public"."pto_balances" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."school_id" = "pto_balances"."school_id") AND ("p"."can_review_pto" = true)))));


--
-- Name: pto_balances pto_balances_update_from_ledger; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "pto_balances_update_from_ledger" ON "public"."pto_balances" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."employees" "e"
  WHERE (("e"."id" = "pto_balances"."employee_id") AND ("e"."school_id" = "pto_balances"."school_id")))));


--
-- Name: pto_ledger; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."pto_ledger" ENABLE ROW LEVEL SECURITY;

--
-- Name: pto_ledger pto_ledger_insert_admin; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "pto_ledger_insert_admin" ON "public"."pto_ledger" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."status" = 'active'::"text") AND (("p"."is_superadmin" = true) OR (("p"."school_id" = "pto_ledger"."school_id") AND ("p"."role" = ANY (ARRAY['admin'::"text", 'hr'::"text"]))) OR (("p"."school_id" = "pto_ledger"."school_id") AND ("p"."can_adjust_pto" = true)))))));


--
-- Name: pto_ledger pto_ledger_read_same_school; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "pto_ledger_read_same_school" ON "public"."pto_ledger" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."status" = 'active'::"text") AND (("p"."is_superadmin" = true) OR ("p"."school_id" = "pto_ledger"."school_id"))))));


--
-- Name: pto_requests; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."pto_requests" ENABLE ROW LEVEL SECURITY;

--
-- Name: pto_requests pto_requests_admin_read; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "pto_requests_admin_read" ON "public"."pto_requests" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."status" = 'active'::"text") AND ("p"."school_id" = "pto_requests"."school_id") AND (("p"."role" = 'admin'::"text") OR ("p"."is_superadmin" = true) OR ("p"."can_approve_pto" = true))))));


--
-- Name: pto_requests pto_requests_admin_update; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "pto_requests_admin_update" ON "public"."pto_requests" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."status" = 'active'::"text") AND ("p"."school_id" = "pto_requests"."school_id") AND (("p"."role" = 'admin'::"text") OR ("p"."is_superadmin" = true) OR ("p"."can_approve_pto" = true))))));


--
-- Name: pto_requests pto_requests_approver_read; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "pto_requests_approver_read" ON "public"."pto_requests" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."status" = 'active'::"text") AND ("p"."school_id" = "pto_requests"."school_id") AND ("p"."can_approve_pto" = true)))));


--
-- Name: pto_requests pto_requests_insert_own; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "pto_requests_insert_own" ON "public"."pto_requests" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."status" = 'active'::"text") AND ("p"."employee_id" = "pto_requests"."employee_id") AND ("p"."school_id" = "pto_requests"."school_id")))));


--
-- Name: pto_requests pto_requests_staff_cancel; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "pto_requests_staff_cancel" ON "public"."pto_requests" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."employee_id" = "pto_requests"."employee_id") AND ("p"."school_id" = "pto_requests"."school_id") AND ("p"."status" = 'active'::"text"))))) WITH CHECK (("status" = 'CANCELLED'::"public"."pto_status"));


--
-- Name: pto_requests pto_requests_staff_read_own; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "pto_requests_staff_read_own" ON "public"."pto_requests" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."status" = 'active'::"text") AND ("p"."employee_id" = "pto_requests"."employee_id")))));


--
-- Name: pto_requests pto_requests_sub_manager_read_coverage; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "pto_requests_sub_manager_read_coverage" ON "public"."pto_requests" FOR SELECT TO "authenticated" USING (((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."status" = 'active'::"text") AND ("p"."school_id" = "pto_requests"."school_id") AND ("p"."can_manage_substitutes" = true)))) AND ("needs_sub_coverage" = true)));


--
-- Name: pto_requests pto_requests_submit_on_behalf; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "pto_requests_submit_on_behalf" ON "public"."pto_requests" FOR INSERT WITH CHECK ((("submitted_by" IS NOT NULL) AND ("submitted_by" = ( SELECT "p"."employee_id"
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."status" = 'active'::"text"))
 LIMIT 1)) AND (( SELECT ("p"."can_submit_on_behalf" AND "p"."can_approve_pto")
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."school_id" = "pto_requests"."school_id") AND ("p"."status" = 'active'::"text"))
 LIMIT 1) = true)));


--
-- Name: request_categories rc_delete; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "rc_delete" ON "public"."request_categories" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."is_superadmin" OR ("p"."role" = 'admin'::"text") OR "p"."can_manage_requests") AND ("p"."school_id" = "request_categories"."school_id")))));


--
-- Name: request_categories rc_insert; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "rc_insert" ON "public"."request_categories" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."is_superadmin" OR ("p"."role" = 'admin'::"text") OR "p"."can_manage_requests") AND ("p"."school_id" = "request_categories"."school_id")))));


--
-- Name: request_categories rc_select; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "rc_select" ON "public"."request_categories" FOR SELECT USING ((("school_id" = ( SELECT "profiles"."school_id"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"())
 LIMIT 1)) AND (("is_restricted" = false) OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."is_superadmin" OR "p"."can_access_admin")))) OR "public"."is_request_category_manager"("id", "auth"."uid"()) OR "public"."is_request_category_visible_to"("id", "auth"."uid"()))));


--
-- Name: request_categories rc_update; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "rc_update" ON "public"."request_categories" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."is_superadmin" OR ("p"."role" = 'admin'::"text") OR "p"."can_manage_requests") AND ("p"."school_id" = "request_categories"."school_id")))));


--
-- Name: request_category_fields rcf_delete; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "rcf_delete" ON "public"."request_category_fields" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM ("public"."request_categories" "rc"
     JOIN "public"."profiles" "p" ON (("p"."user_id" = "auth"."uid"())))
  WHERE (("rc"."id" = "request_category_fields"."category_id") AND ("rc"."school_id" = "p"."school_id") AND ("p"."is_superadmin" OR ("p"."role" = 'admin'::"text") OR "p"."can_manage_requests")))));


--
-- Name: request_category_fields rcf_insert; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "rcf_insert" ON "public"."request_category_fields" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM ("public"."request_categories" "rc"
     JOIN "public"."profiles" "p" ON (("p"."user_id" = "auth"."uid"())))
  WHERE (("rc"."id" = "request_category_fields"."category_id") AND ("rc"."school_id" = "p"."school_id") AND ("p"."is_superadmin" OR ("p"."role" = 'admin'::"text") OR "p"."can_manage_requests")))));


--
-- Name: request_category_fields rcf_select; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "rcf_select" ON "public"."request_category_fields" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."request_categories" "rc"
  WHERE (("rc"."id" = "request_category_fields"."category_id") AND ("rc"."school_id" = ( SELECT "profiles"."school_id"
           FROM "public"."profiles"
          WHERE ("profiles"."user_id" = "auth"."uid"())
         LIMIT 1))))));


--
-- Name: request_category_fields rcf_update; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "rcf_update" ON "public"."request_category_fields" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM ("public"."request_categories" "rc"
     JOIN "public"."profiles" "p" ON (("p"."user_id" = "auth"."uid"())))
  WHERE (("rc"."id" = "request_category_fields"."category_id") AND ("rc"."school_id" = "p"."school_id") AND ("p"."is_superadmin" OR ("p"."role" = 'admin'::"text") OR "p"."can_manage_requests")))));


--
-- Name: request_category_managers rcm_delete; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "rcm_delete" ON "public"."request_category_managers" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM ("public"."request_categories" "rc"
     JOIN "public"."profiles" "p" ON (("p"."user_id" = "auth"."uid"())))
  WHERE (("rc"."id" = "request_category_managers"."category_id") AND ("rc"."school_id" = "p"."school_id") AND ("p"."is_superadmin" OR ("p"."role" = 'admin'::"text") OR "p"."can_manage_requests")))));


--
-- Name: request_category_managers rcm_insert; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "rcm_insert" ON "public"."request_category_managers" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM ("public"."request_categories" "rc"
     JOIN "public"."profiles" "p" ON (("p"."user_id" = "auth"."uid"())))
  WHERE (("rc"."id" = "request_category_managers"."category_id") AND ("rc"."school_id" = "p"."school_id") AND ("p"."is_superadmin" OR ("p"."role" = 'admin'::"text") OR "p"."can_manage_requests")))));


--
-- Name: request_category_managers rcm_select; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "rcm_select" ON "public"."request_category_managers" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."is_superadmin" OR ("p"."role" = 'admin'::"text") OR "p"."can_manage_requests" OR ("request_category_managers"."profile_id" = "p"."id"))))));


--
-- Name: request_category_visibility rcv_delete; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "rcv_delete" ON "public"."request_category_visibility" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM ("public"."request_categories" "rc"
     JOIN "public"."profiles" "p" ON (("p"."user_id" = "auth"."uid"())))
  WHERE (("rc"."id" = "request_category_visibility"."category_id") AND ("rc"."school_id" = "p"."school_id") AND ("p"."is_superadmin" OR "p"."can_access_admin")))));


--
-- Name: request_category_visibility rcv_insert; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "rcv_insert" ON "public"."request_category_visibility" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM ("public"."request_categories" "rc"
     JOIN "public"."profiles" "p" ON (("p"."user_id" = "auth"."uid"())))
  WHERE (("rc"."id" = "request_category_visibility"."category_id") AND ("rc"."school_id" = "p"."school_id") AND ("p"."is_superadmin" OR "p"."can_access_admin")))));


--
-- Name: request_category_visibility rcv_select; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "rcv_select" ON "public"."request_category_visibility" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."is_superadmin" OR "p"."can_access_admin" OR ("request_category_visibility"."profile_id" = "p"."id"))))));


--
-- Name: request_categories; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."request_categories" ENABLE ROW LEVEL SECURITY;

--
-- Name: request_category_fields; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."request_category_fields" ENABLE ROW LEVEL SECURITY;

--
-- Name: request_category_managers; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."request_category_managers" ENABLE ROW LEVEL SECURITY;

--
-- Name: request_category_visibility; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."request_category_visibility" ENABLE ROW LEVEL SECURITY;

--
-- Name: reservable_resources; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."reservable_resources" ENABLE ROW LEVEL SECURITY;

--
-- Name: reservable_resources reservable_resources_read; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "reservable_resources_read" ON "public"."reservable_resources" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."status" = 'active'::"text") AND ("p"."can_login" = true) AND ("p"."school_id" = "reservable_resources"."school_id")))));


--
-- Name: reservable_resources reservable_resources_write; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "reservable_resources_write" ON "public"."reservable_resources" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."status" = 'active'::"text") AND (("p"."is_superadmin" = true) OR (("p"."school_id" = "reservable_resources"."school_id") AND (("p"."role" = 'admin'::"text") OR ("p"."can_manage_reservations" = true)))))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."status" = 'active'::"text") AND (("p"."is_superadmin" = true) OR (("p"."school_id" = "reservable_resources"."school_id") AND (("p"."role" = 'admin'::"text") OR ("p"."can_manage_reservations" = true))))))));


--
-- Name: reservations; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."reservations" ENABLE ROW LEVEL SECURITY;

--
-- Name: reservations reservations_delete; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "reservations_delete" ON "public"."reservations" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."status" = 'active'::"text") AND (("p"."is_superadmin" = true) OR (("p"."school_id" = "reservations"."school_id") AND (("p"."role" = 'admin'::"text") OR ("p"."can_manage_reservations" = true) OR ("p"."id" = "reservations"."reserved_by_profile_id"))))))));


--
-- Name: reservations reservations_insert; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "reservations_insert" ON "public"."reservations" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."status" = 'active'::"text") AND ("p"."can_login" = true) AND (("p"."is_superadmin" = true) OR (("p"."school_id" = "reservations"."school_id") AND ("p"."id" = "reservations"."reserved_by_profile_id")))))));


--
-- Name: reservations reservations_read; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "reservations_read" ON "public"."reservations" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."status" = 'active'::"text") AND ("p"."can_login" = true) AND ("p"."school_id" = "reservations"."school_id")))));


--
-- Name: reservations reservations_update; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "reservations_update" ON "public"."reservations" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."status" = 'active'::"text") AND (("p"."is_superadmin" = true) OR (("p"."school_id" = "reservations"."school_id") AND (("p"."role" = 'admin'::"text") OR ("p"."can_manage_reservations" = true) OR ("p"."id" = "reservations"."reserved_by_profile_id")))))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."status" = 'active'::"text") AND (("p"."is_superadmin" = true) OR (("p"."school_id" = "reservations"."school_id") AND (("p"."role" = 'admin'::"text") OR ("p"."can_manage_reservations" = true) OR ("p"."id" = "reservations"."reserved_by_profile_id"))))))));


--
-- Name: resource_document_bookmarks resource_doc_bookmarks_own; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "resource_doc_bookmarks_own" ON "public"."resource_document_bookmarks" USING (("profile_id" = "public"."current_user_profile_id"())) WITH CHECK (("profile_id" = "public"."current_user_profile_id"()));


--
-- Name: resource_document_categories resource_doc_categories_read; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "resource_doc_categories_read" ON "public"."resource_document_categories" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."status" = 'active'::"text") AND ("p"."can_login" = true) AND ("p"."school_id" = "resource_document_categories"."school_id")))));


--
-- Name: resource_document_categories resource_doc_categories_write; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "resource_doc_categories_write" ON "public"."resource_document_categories" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."status" = 'active'::"text") AND (("p"."is_superadmin" = true) OR (("p"."school_id" = "resource_document_categories"."school_id") AND (("p"."role" = 'admin'::"text") OR ("p"."can_manage_resource_docs" = true)))))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."status" = 'active'::"text") AND (("p"."is_superadmin" = true) OR (("p"."school_id" = "resource_document_categories"."school_id") AND (("p"."role" = 'admin'::"text") OR ("p"."can_manage_resource_docs" = true))))))));


--
-- Name: resource_document_bookmarks; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."resource_document_bookmarks" ENABLE ROW LEVEL SECURITY;

--
-- Name: resource_document_categories; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."resource_document_categories" ENABLE ROW LEVEL SECURITY;

--
-- Name: resource_documents; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."resource_documents" ENABLE ROW LEVEL SECURITY;

--
-- Name: resource_documents resource_documents_read; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "resource_documents_read" ON "public"."resource_documents" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."status" = 'active'::"text") AND ("p"."can_login" = true) AND ("p"."school_id" = "resource_documents"."school_id")))));


--
-- Name: resource_documents resource_documents_write; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "resource_documents_write" ON "public"."resource_documents" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."status" = 'active'::"text") AND (("p"."is_superadmin" = true) OR (("p"."school_id" = "resource_documents"."school_id") AND (("p"."role" = 'admin'::"text") OR ("p"."can_manage_resource_docs" = true)))))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."status" = 'active'::"text") AND (("p"."is_superadmin" = true) OR (("p"."school_id" = "resource_documents"."school_id") AND (("p"."role" = 'admin'::"text") OR ("p"."can_manage_resource_docs" = true))))))));


--
-- Name: resource_groups; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."resource_groups" ENABLE ROW LEVEL SECURITY;

--
-- Name: resource_groups resource_groups_read; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "resource_groups_read" ON "public"."resource_groups" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."status" = 'active'::"text") AND ("p"."can_login" = true) AND ("p"."school_id" = "resource_groups"."school_id")))));


--
-- Name: resource_groups resource_groups_write; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "resource_groups_write" ON "public"."resource_groups" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."status" = 'active'::"text") AND (("p"."is_superadmin" = true) OR (("p"."school_id" = "resource_groups"."school_id") AND (("p"."role" = 'admin'::"text") OR ("p"."can_manage_reservations" = true)))))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."status" = 'active'::"text") AND (("p"."is_superadmin" = true) OR (("p"."school_id" = "resource_groups"."school_id") AND (("p"."role" = 'admin'::"text") OR ("p"."can_manage_reservations" = true))))))));


--
-- Name: resource_time_blocks; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."resource_time_blocks" ENABLE ROW LEVEL SECURITY;

--
-- Name: resource_time_blocks resource_time_blocks_read; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "resource_time_blocks_read" ON "public"."resource_time_blocks" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."status" = 'active'::"text") AND ("p"."can_login" = true) AND ("p"."school_id" = "resource_time_blocks"."school_id")))));


--
-- Name: resource_time_blocks resource_time_blocks_write; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "resource_time_blocks_write" ON "public"."resource_time_blocks" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."status" = 'active'::"text") AND (("p"."is_superadmin" = true) OR (("p"."school_id" = "resource_time_blocks"."school_id") AND (("p"."role" = 'admin'::"text") OR ("p"."can_manage_reservations" = true)))))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."status" = 'active'::"text") AND (("p"."is_superadmin" = true) OR (("p"."school_id" = "resource_time_blocks"."school_id") AND (("p"."role" = 'admin'::"text") OR ("p"."can_manage_reservations" = true))))))));


--
-- Name: pto_balances same_school_read; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "same_school_read" ON "public"."pto_balances" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."status" = 'active'::"text") AND (("p"."is_superadmin" = true) OR ("p"."school_id" = "pto_balances"."school_id"))))));


--
-- Name: pto_ledger same_school_read; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "same_school_read" ON "public"."pto_ledger" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."status" = 'active'::"text") AND (("p"."is_superadmin" = true) OR ("p"."school_id" = "pto_ledger"."school_id"))))));


--
-- Name: school_domains same_school_read; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "same_school_read" ON "public"."school_domains" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."status" = 'active'::"text") AND (("p"."is_superadmin" = true) OR ("p"."school_id" = "school_domains"."school_id"))))));


--
-- Name: student_promotion_log school members can manage their promotion log; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "school members can manage their promotion log" ON "public"."student_promotion_log" USING (("school_id" = "public"."current_user_school_id"())) WITH CHECK (("school_id" = "public"."current_user_school_id"()));


--
-- Name: bulk_upload_logs school members can read their upload logs; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "school members can read their upload logs" ON "public"."bulk_upload_logs" FOR SELECT USING (("school_id" = "public"."current_user_school_id"()));


--
-- Name: campuses school members read campuses; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "school members read campuses" ON "public"."campuses" FOR SELECT TO "authenticated" USING (("school_id" = ( SELECT "profiles"."school_id"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"()))));


--
-- Name: school_calendar_events; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."school_calendar_events" ENABLE ROW LEVEL SECURITY;

--
-- Name: school_domains; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."school_domains" ENABLE ROW LEVEL SECURITY;

--
-- Name: school_modules; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."school_modules" ENABLE ROW LEVEL SECURITY;

--
-- Name: school_modules school_modules_write_superadmin; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "school_modules_write_superadmin" ON "public"."school_modules" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."is_superadmin" = true))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."is_superadmin" = true)))));


--
-- Name: school_pto_types; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."school_pto_types" ENABLE ROW LEVEL SECURITY;

--
-- Name: school_settings; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."school_settings" ENABLE ROW LEVEL SECURITY;

--
-- Name: school_student_sequences; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."school_student_sequences" ENABLE ROW LEVEL SECURITY;

--
-- Name: schools; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."schools" ENABLE ROW LEVEL SECURITY;

--
-- Name: schools schools_anon_read; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "schools_anon_read" ON "public"."schools" FOR SELECT TO "anon" USING (true);


--
-- Name: schools schools_insert_superadmin; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "schools_insert_superadmin" ON "public"."schools" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."is_superadmin" = true)))));


--
-- Name: schools schools_read_my_school; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "schools_read_my_school" ON "public"."schools" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."status" = 'active'::"text") AND (("p"."is_superadmin" = true) OR ("p"."school_id" = "schools"."id"))))));


--
-- Name: schools schools_update_superadmin; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "schools_update_superadmin" ON "public"."schools" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."is_superadmin" = true)))));


--
-- Name: staff_requests sr_insert; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "sr_insert" ON "public"."staff_requests" FOR INSERT WITH CHECK ((("school_id" = ( SELECT "profiles"."school_id"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"())
 LIMIT 1)) AND ("submitted_by" = ( SELECT "profiles"."id"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"())
 LIMIT 1)) AND (EXISTS ( SELECT 1
   FROM "public"."request_categories" "rc"
  WHERE (("rc"."id" = "staff_requests"."category_id") AND ("rc"."school_id" = "staff_requests"."school_id") AND (("rc"."is_restricted" = false) OR (EXISTS ( SELECT 1
           FROM "public"."profiles" "p"
          WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."is_superadmin" OR "p"."can_access_admin")))) OR "public"."is_request_category_manager"("rc"."id", "auth"."uid"()) OR "public"."is_request_category_visible_to"("rc"."id", "auth"."uid"())))))));


--
-- Name: staff_requests sr_select; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "sr_select" ON "public"."staff_requests" FOR SELECT USING ((("school_id" = ( SELECT "profiles"."school_id"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"())
 LIMIT 1)) AND (("submitted_by" = ( SELECT "profiles"."id"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"())
 LIMIT 1)) OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."is_superadmin" OR "p"."can_access_admin")))) OR (EXISTS ( SELECT 1
   FROM ("public"."request_category_managers" "rcm"
     JOIN "public"."profiles" "p" ON (("p"."id" = "rcm"."profile_id")))
  WHERE (("rcm"."category_id" = "staff_requests"."category_id") AND ("p"."user_id" = "auth"."uid"())))))));


--
-- Name: staff_requests sr_update; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "sr_update" ON "public"."staff_requests" FOR UPDATE USING ((("school_id" = ( SELECT "profiles"."school_id"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"())
 LIMIT 1)) AND ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."is_superadmin" OR "p"."can_access_admin")))) OR (EXISTS ( SELECT 1
   FROM ("public"."request_category_managers" "rcm"
     JOIN "public"."profiles" "p" ON (("p"."id" = "rcm"."profile_id")))
  WHERE (("rcm"."category_id" = "staff_requests"."category_id") AND ("p"."user_id" = "auth"."uid"())))))));


--
-- Name: staff_request_responses srr_insert; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "srr_insert" ON "public"."staff_request_responses" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."staff_requests" "sr"
  WHERE (("sr"."id" = "staff_request_responses"."request_id") AND ("sr"."submitted_by" = ( SELECT "profiles"."id"
           FROM "public"."profiles"
          WHERE ("profiles"."user_id" = "auth"."uid"())
         LIMIT 1))))));


--
-- Name: staff_request_responses srr_select; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "srr_select" ON "public"."staff_request_responses" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."staff_requests" "sr"
  WHERE (("sr"."id" = "staff_request_responses"."request_id") AND ("sr"."school_id" = ( SELECT "profiles"."school_id"
           FROM "public"."profiles"
          WHERE ("profiles"."user_id" = "auth"."uid"())
         LIMIT 1)) AND (("sr"."submitted_by" = ( SELECT "profiles"."id"
           FROM "public"."profiles"
          WHERE ("profiles"."user_id" = "auth"."uid"())
         LIMIT 1)) OR (EXISTS ( SELECT 1
           FROM "public"."profiles" "p"
          WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."is_superadmin" OR "p"."can_access_admin")))) OR (EXISTS ( SELECT 1
           FROM ("public"."request_category_managers" "rcm"
             JOIN "public"."profiles" "p" ON (("p"."id" = "rcm"."profile_id")))
          WHERE (("rcm"."category_id" = "sr"."category_id") AND ("p"."user_id" = "auth"."uid"())))))))));


--
-- Name: school_settings staff can read school settings; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "staff can read school settings" ON "public"."school_settings" FOR SELECT USING (("school_id" = "public"."current_user_school_id"()));


--
-- Name: staff_groups; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."staff_groups" ENABLE ROW LEVEL SECURITY;

--
-- Name: staff_license_ceus; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."staff_license_ceus" ENABLE ROW LEVEL SECURITY;

--
-- Name: staff_license_files; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."staff_license_files" ENABLE ROW LEVEL SECURITY;

--
-- Name: staff_license_history; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."staff_license_history" ENABLE ROW LEVEL SECURITY;

--
-- Name: staff_licenses; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."staff_licenses" ENABLE ROW LEVEL SECURITY;

--
-- Name: staff_request_responses; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."staff_request_responses" ENABLE ROW LEVEL SECURITY;

--
-- Name: staff_requests; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."staff_requests" ENABLE ROW LEVEL SECURITY;

--
-- Name: student_placement_flags; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."student_placement_flags" ENABLE ROW LEVEL SECURITY;

--
-- Name: student_placement_flags student_placement_flags_read; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "student_placement_flags_read" ON "public"."student_placement_flags" FOR SELECT USING (("flag_id" IN ( SELECT "placement_flags"."id"
   FROM "public"."placement_flags"
  WHERE ("placement_flags"."school_id" = ( SELECT "profiles"."school_id"
           FROM "public"."profiles"
          WHERE ("profiles"."user_id" = "auth"."uid"())
         LIMIT 1)))));


--
-- Name: student_placement_flags student_placement_flags_write; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "student_placement_flags_write" ON "public"."student_placement_flags" USING ((("flag_id" IN ( SELECT "placement_flags"."id"
   FROM "public"."placement_flags"
  WHERE ("placement_flags"."school_id" = ( SELECT "profiles"."school_id"
           FROM "public"."profiles"
          WHERE ("profiles"."user_id" = "auth"."uid"())
         LIMIT 1)))) AND ((( SELECT "profiles"."is_superadmin"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"())
 LIMIT 1) = true) OR (( SELECT "profiles"."role"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"())
 LIMIT 1) = 'admin'::"text") OR (( SELECT "profiles"."can_manage_placement"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"())
 LIMIT 1) = true)))) WITH CHECK ((("flag_id" IN ( SELECT "placement_flags"."id"
   FROM "public"."placement_flags"
  WHERE ("placement_flags"."school_id" = ( SELECT "profiles"."school_id"
           FROM "public"."profiles"
          WHERE ("profiles"."user_id" = "auth"."uid"())
         LIMIT 1)))) AND ((( SELECT "profiles"."is_superadmin"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"())
 LIMIT 1) = true) OR (( SELECT "profiles"."role"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"())
 LIMIT 1) = 'admin'::"text") OR (( SELECT "profiles"."can_manage_placement"
   FROM "public"."profiles"
  WHERE ("profiles"."user_id" = "auth"."uid"())
 LIMIT 1) = true))));


--
-- Name: student_promotion_log; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."student_promotion_log" ENABLE ROW LEVEL SECURITY;

--
-- Name: students; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."students" ENABLE ROW LEVEL SECURITY;

--
-- Name: students students_delete_admin; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "students_delete_admin" ON "public"."students" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."status" = 'active'::"text") AND (("p"."is_superadmin" = true) OR (("p"."role" = 'admin'::"text") AND ("p"."school_id" = "students"."school_id")) OR (("p"."can_manage_students" = true) AND ("p"."school_id" = "students"."school_id")))))));


--
-- Name: students students_insert_admin; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "students_insert_admin" ON "public"."students" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."status" = 'active'::"text") AND (("p"."is_superadmin" = true) OR ("p"."role" = 'admin'::"text"))))));


--
-- Name: students students_insert_manage_students; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "students_insert_manage_students" ON "public"."students" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."status" = 'active'::"text") AND ("p"."school_id" = "students"."school_id") AND ("p"."can_manage_students" = true)))));


--
-- Name: students students_read_same_school; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "students_read_same_school" ON "public"."students" FOR SELECT USING ("public"."current_user_is_active_in_school"("school_id"));


--
-- Name: students students_update_admin; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "students_update_admin" ON "public"."students" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."status" = 'active'::"text") AND (("p"."is_superadmin" = true) OR (("p"."role" = 'admin'::"text") AND ("p"."school_id" = "students"."school_id"))))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."status" = 'active'::"text") AND (("p"."is_superadmin" = true) OR (("p"."role" = 'admin'::"text") AND ("p"."school_id" = "students"."school_id")))))));


--
-- Name: students students_update_manage_students; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "students_update_manage_students" ON "public"."students" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."status" = 'active'::"text") AND ("p"."school_id" = "students"."school_id") AND ("p"."can_manage_students" = true))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."user_id" = "auth"."uid"()) AND ("p"."status" = 'active'::"text") AND ("p"."school_id" = "students"."school_id") AND ("p"."can_manage_students" = true)))));


--
-- Name: substitute_assignments; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."substitute_assignments" ENABLE ROW LEVEL SECURITY;

--
-- Name: substitutes; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."substitutes" ENABLE ROW LEVEL SECURITY;

--
-- Name: SCHEMA "public"; Type: ACL; Schema: -; Owner: pg_database_owner
--

GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";


--
-- Name: FUNCTION "assert_carpool_student_same_school"(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION "public"."assert_carpool_student_same_school"() TO "anon";
GRANT ALL ON FUNCTION "public"."assert_carpool_student_same_school"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."assert_carpool_student_same_school"() TO "service_role";


--
-- Name: FUNCTION "assert_carpool_tag_free"(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION "public"."assert_carpool_tag_free"() TO "anon";
GRANT ALL ON FUNCTION "public"."assert_carpool_tag_free"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."assert_carpool_tag_free"() TO "service_role";


--
-- Name: FUNCTION "assert_family_tag_free"(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION "public"."assert_family_tag_free"() TO "anon";
GRANT ALL ON FUNCTION "public"."assert_family_tag_free"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."assert_family_tag_free"() TO "service_role";


--
-- Name: FUNCTION "assign_student_number"(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION "public"."assign_student_number"() TO "anon";
GRANT ALL ON FUNCTION "public"."assign_student_number"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."assign_student_number"() TO "service_role";


--
-- Name: FUNCTION "claim_or_create_profile_for_user"(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION "public"."claim_or_create_profile_for_user"() TO "anon";
GRANT ALL ON FUNCTION "public"."claim_or_create_profile_for_user"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."claim_or_create_profile_for_user"() TO "service_role";


--
-- Name: FUNCTION "claim_profile_for_user"(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION "public"."claim_profile_for_user"() TO "anon";
GRANT ALL ON FUNCTION "public"."claim_profile_for_user"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."claim_profile_for_user"() TO "service_role";


--
-- Name: FUNCTION "compliance_volunteer_match_key"("p_first_name" "text", "p_last_name" "text"); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION "public"."compliance_volunteer_match_key"("p_first_name" "text", "p_last_name" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."compliance_volunteer_match_key"("p_first_name" "text", "p_last_name" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."compliance_volunteer_match_key"("p_first_name" "text", "p_last_name" "text") TO "service_role";


--
-- Name: FUNCTION "compute_intake_match"(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION "public"."compute_intake_match"() TO "anon";
GRANT ALL ON FUNCTION "public"."compute_intake_match"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."compute_intake_match"() TO "service_role";


--
-- Name: FUNCTION "convert_placement_teacher_to_placeholder"(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION "public"."convert_placement_teacher_to_placeholder"() TO "anon";
GRANT ALL ON FUNCTION "public"."convert_placement_teacher_to_placeholder"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."convert_placement_teacher_to_placeholder"() TO "service_role";


--
-- Name: FUNCTION "create_profile_for_new_user"(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION "public"."create_profile_for_new_user"() TO "anon";
GRANT ALL ON FUNCTION "public"."create_profile_for_new_user"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_profile_for_new_user"() TO "service_role";


--
-- Name: FUNCTION "current_user_can_manage_access"(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION "public"."current_user_can_manage_access"() TO "anon";
GRANT ALL ON FUNCTION "public"."current_user_can_manage_access"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."current_user_can_manage_access"() TO "service_role";


--
-- Name: FUNCTION "current_user_can_manage_licensure"("target_school_id" "uuid"); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION "public"."current_user_can_manage_licensure"("target_school_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."current_user_can_manage_licensure"("target_school_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."current_user_can_manage_licensure"("target_school_id" "uuid") TO "service_role";


--
-- Name: FUNCTION "current_user_can_manage_requests"(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION "public"."current_user_can_manage_requests"() TO "anon";
GRANT ALL ON FUNCTION "public"."current_user_can_manage_requests"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."current_user_can_manage_requests"() TO "service_role";


--
-- Name: FUNCTION "current_user_can_manage_substitutes"("target_school_id" "uuid"); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION "public"."current_user_can_manage_substitutes"("target_school_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."current_user_can_manage_substitutes"("target_school_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."current_user_can_manage_substitutes"("target_school_id" "uuid") TO "service_role";


--
-- Name: FUNCTION "current_user_can_view_trip"("target_school_id" "uuid", "trip_id" "uuid", "trip_creator" "uuid"); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION "public"."current_user_can_view_trip"("target_school_id" "uuid", "trip_id" "uuid", "trip_creator" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."current_user_can_view_trip"("target_school_id" "uuid", "trip_id" "uuid", "trip_creator" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."current_user_can_view_trip"("target_school_id" "uuid", "trip_id" "uuid", "trip_creator" "uuid") TO "service_role";


--
-- Name: FUNCTION "current_user_is_active_in_school"("target_school_id" "uuid"); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION "public"."current_user_is_active_in_school"("target_school_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."current_user_is_active_in_school"("target_school_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."current_user_is_active_in_school"("target_school_id" "uuid") TO "service_role";


--
-- Name: FUNCTION "current_user_manages_submitter"("p_submitter_profile_id" "uuid"); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION "public"."current_user_manages_submitter"("p_submitter_profile_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."current_user_manages_submitter"("p_submitter_profile_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."current_user_manages_submitter"("p_submitter_profile_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."current_user_manages_submitter"("p_submitter_profile_id" "uuid") TO "service_role";


--
-- Name: FUNCTION "current_user_profile_id"(); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION "public"."current_user_profile_id"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."current_user_profile_id"() TO "anon";
GRANT ALL ON FUNCTION "public"."current_user_profile_id"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."current_user_profile_id"() TO "service_role";


--
-- Name: FUNCTION "current_user_school_id"(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION "public"."current_user_school_id"() TO "anon";
GRANT ALL ON FUNCTION "public"."current_user_school_id"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."current_user_school_id"() TO "service_role";


--
-- Name: FUNCTION "enforce_fallback_approver_has_pto_access"(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION "public"."enforce_fallback_approver_has_pto_access"() TO "anon";
GRANT ALL ON FUNCTION "public"."enforce_fallback_approver_has_pto_access"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."enforce_fallback_approver_has_pto_access"() TO "service_role";


--
-- Name: FUNCTION "enforce_reservation_insert_status"(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION "public"."enforce_reservation_insert_status"() TO "anon";
GRANT ALL ON FUNCTION "public"."enforce_reservation_insert_status"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."enforce_reservation_insert_status"() TO "service_role";


--
-- Name: FUNCTION "enforce_reservation_owner_update"(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION "public"."enforce_reservation_owner_update"() TO "anon";
GRANT ALL ON FUNCTION "public"."enforce_reservation_owner_update"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."enforce_reservation_owner_update"() TO "service_role";


--
-- Name: FUNCTION "enforce_supervisor_is_pto_approver"(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION "public"."enforce_supervisor_is_pto_approver"() TO "anon";
GRANT ALL ON FUNCTION "public"."enforce_supervisor_is_pto_approver"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."enforce_supervisor_is_pto_approver"() TO "service_role";


--
-- Name: FUNCTION "ft_get_school_id"("trip_id" "uuid"); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION "public"."ft_get_school_id"("trip_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."ft_get_school_id"("trip_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."ft_get_school_id"("trip_id" "uuid") TO "service_role";


--
-- Name: FUNCTION "ft_is_manager"("trip_id" "uuid", "prof_id" "uuid"); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION "public"."ft_is_manager"("trip_id" "uuid", "prof_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."ft_is_manager"("trip_id" "uuid", "prof_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."ft_is_manager"("trip_id" "uuid", "prof_id" "uuid") TO "service_role";


--
-- Name: FUNCTION "get_calendar_ics_link"(); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION "public"."get_calendar_ics_link"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_calendar_ics_link"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_calendar_ics_link"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_calendar_ics_link"() TO "service_role";


--
-- Name: FUNCTION "get_trip_managers"("trip_id" "uuid"); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION "public"."get_trip_managers"("trip_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."get_trip_managers"("trip_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_trip_managers"("trip_id" "uuid") TO "service_role";


--
-- Name: FUNCTION "handle_new_auth_user"(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION "public"."handle_new_auth_user"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_new_auth_user"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_new_auth_user"() TO "service_role";


--
-- Name: FUNCTION "handle_pto_ledger_insert"(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION "public"."handle_pto_ledger_insert"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_pto_ledger_insert"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_pto_ledger_insert"() TO "service_role";


--
-- Name: FUNCTION "handle_pto_status_change"(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION "public"."handle_pto_status_change"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_pto_status_change"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_pto_status_change"() TO "service_role";


--
-- Name: FUNCTION "is_request_category_manager"("p_category_id" "uuid", "p_user_id" "uuid"); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION "public"."is_request_category_manager"("p_category_id" "uuid", "p_user_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_request_category_manager"("p_category_id" "uuid", "p_user_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."is_request_category_manager"("p_category_id" "uuid", "p_user_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_request_category_manager"("p_category_id" "uuid", "p_user_id" "uuid") TO "service_role";


--
-- Name: FUNCTION "is_request_category_visible_to"("p_category_id" "uuid", "p_user_id" "uuid"); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION "public"."is_request_category_visible_to"("p_category_id" "uuid", "p_user_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_request_category_visible_to"("p_category_id" "uuid", "p_user_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."is_request_category_visible_to"("p_category_id" "uuid", "p_user_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_request_category_visible_to"("p_category_id" "uuid", "p_user_id" "uuid") TO "service_role";


--
-- Name: FUNCTION "log_permission_changes"(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION "public"."log_permission_changes"() TO "anon";
GRANT ALL ON FUNCTION "public"."log_permission_changes"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."log_permission_changes"() TO "service_role";


--
-- Name: FUNCTION "notify_pto_event"(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION "public"."notify_pto_event"() TO "anon";
GRANT ALL ON FUNCTION "public"."notify_pto_event"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."notify_pto_event"() TO "service_role";


--
-- Name: FUNCTION "prevent_school_delete"(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION "public"."prevent_school_delete"() TO "anon";
GRANT ALL ON FUNCTION "public"."prevent_school_delete"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."prevent_school_delete"() TO "service_role";


--
-- Name: FUNCTION "regenerate_calendar_ics_token"(); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION "public"."regenerate_calendar_ics_token"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."regenerate_calendar_ics_token"() TO "anon";
GRANT ALL ON FUNCTION "public"."regenerate_calendar_ics_token"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."regenerate_calendar_ics_token"() TO "service_role";


--
-- Name: FUNCTION "rls_auto_enable"(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION "public"."rls_auto_enable"() TO "anon";
GRANT ALL ON FUNCTION "public"."rls_auto_enable"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."rls_auto_enable"() TO "service_role";


--
-- Name: FUNCTION "set_updated_at"(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "service_role";


--
-- Name: FUNCTION "sync_last_sign_in"(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION "public"."sync_last_sign_in"() TO "anon";
GRANT ALL ON FUNCTION "public"."sync_last_sign_in"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."sync_last_sign_in"() TO "service_role";


--
-- Name: TABLE "access_requests"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."access_requests" TO "anon";
GRANT ALL ON TABLE "public"."access_requests" TO "authenticated";
GRANT ALL ON TABLE "public"."access_requests" TO "service_role";


--
-- Name: TABLE "bulk_upload_logs"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."bulk_upload_logs" TO "anon";
GRANT ALL ON TABLE "public"."bulk_upload_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."bulk_upload_logs" TO "service_role";


--
-- Name: TABLE "bus_groups"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."bus_groups" TO "anon";
GRANT ALL ON TABLE "public"."bus_groups" TO "authenticated";
GRANT ALL ON TABLE "public"."bus_groups" TO "service_role";


--
-- Name: TABLE "campuses"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."campuses" TO "anon";
GRANT ALL ON TABLE "public"."campuses" TO "authenticated";
GRANT ALL ON TABLE "public"."campuses" TO "service_role";


--
-- Name: TABLE "carline_bus_arrivals"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."carline_bus_arrivals" TO "anon";
GRANT ALL ON TABLE "public"."carline_bus_arrivals" TO "authenticated";
GRANT ALL ON TABLE "public"."carline_bus_arrivals" TO "service_role";


--
-- Name: TABLE "carline_calls"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."carline_calls" TO "anon";
GRANT ALL ON TABLE "public"."carline_calls" TO "authenticated";
GRANT ALL ON TABLE "public"."carline_calls" TO "service_role";


--
-- Name: TABLE "carline_events"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."carline_events" TO "anon";
GRANT ALL ON TABLE "public"."carline_events" TO "authenticated";
GRANT ALL ON TABLE "public"."carline_events" TO "service_role";


--
-- Name: TABLE "carline_pickup_groups"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."carline_pickup_groups" TO "anon";
GRANT ALL ON TABLE "public"."carline_pickup_groups" TO "authenticated";
GRANT ALL ON TABLE "public"."carline_pickup_groups" TO "service_role";


--
-- Name: TABLE "carline_tags"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."carline_tags" TO "anon";
GRANT ALL ON TABLE "public"."carline_tags" TO "authenticated";
GRANT ALL ON TABLE "public"."carline_tags" TO "service_role";


--
-- Name: TABLE "carpool_students"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."carpool_students" TO "anon";
GRANT ALL ON TABLE "public"."carpool_students" TO "authenticated";
GRANT ALL ON TABLE "public"."carpool_students" TO "service_role";


--
-- Name: TABLE "carpools"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."carpools" TO "anon";
GRANT ALL ON TABLE "public"."carpools" TO "authenticated";
GRANT ALL ON TABLE "public"."carpools" TO "service_role";


--
-- Name: TABLE "compliance_agreements"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."compliance_agreements" TO "anon";
GRANT ALL ON TABLE "public"."compliance_agreements" TO "authenticated";
GRANT ALL ON TABLE "public"."compliance_agreements" TO "service_role";


--
-- Name: TABLE "compliance_bg_check_requests"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."compliance_bg_check_requests" TO "anon";
GRANT ALL ON TABLE "public"."compliance_bg_check_requests" TO "authenticated";
GRANT ALL ON TABLE "public"."compliance_bg_check_requests" TO "service_role";


--
-- Name: TABLE "compliance_form_links"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."compliance_form_links" TO "anon";
GRANT ALL ON TABLE "public"."compliance_form_links" TO "authenticated";
GRANT ALL ON TABLE "public"."compliance_form_links" TO "service_role";


--
-- Name: TABLE "compliance_form_templates"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."compliance_form_templates" TO "anon";
GRANT ALL ON TABLE "public"."compliance_form_templates" TO "authenticated";
GRANT ALL ON TABLE "public"."compliance_form_templates" TO "service_role";


--
-- Name: TABLE "compliance_report_grants"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."compliance_report_grants" TO "anon";
GRANT ALL ON TABLE "public"."compliance_report_grants" TO "authenticated";
GRANT ALL ON TABLE "public"."compliance_report_grants" TO "service_role";


--
-- Name: TABLE "compliance_volunteers"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."compliance_volunteers" TO "anon";
GRANT ALL ON TABLE "public"."compliance_volunteers" TO "authenticated";
GRANT ALL ON TABLE "public"."compliance_volunteers" TO "service_role";


--
-- Name: TABLE "compliance_volunteer_status"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."compliance_volunteer_status" TO "anon";
GRANT ALL ON TABLE "public"."compliance_volunteer_status" TO "authenticated";
GRANT ALL ON TABLE "public"."compliance_volunteer_status" TO "service_role";


--
-- Name: TABLE "employee_pto_policies"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."employee_pto_policies" TO "anon";
GRANT ALL ON TABLE "public"."employee_pto_policies" TO "authenticated";
GRANT ALL ON TABLE "public"."employee_pto_policies" TO "service_role";


--
-- Name: TABLE "employees"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."employees" TO "anon";
GRANT ALL ON TABLE "public"."employees" TO "authenticated";
GRANT ALL ON TABLE "public"."employees" TO "service_role";


--
-- Name: TABLE "families"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."families" TO "anon";
GRANT ALL ON TABLE "public"."families" TO "authenticated";
GRANT ALL ON TABLE "public"."families" TO "service_role";


--
-- Name: TABLE "field_trip_chaperones"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."field_trip_chaperones" TO "anon";
GRANT ALL ON TABLE "public"."field_trip_chaperones" TO "authenticated";
GRANT ALL ON TABLE "public"."field_trip_chaperones" TO "service_role";


--
-- Name: TABLE "field_trip_managers"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."field_trip_managers" TO "anon";
GRANT ALL ON TABLE "public"."field_trip_managers" TO "authenticated";
GRANT ALL ON TABLE "public"."field_trip_managers" TO "service_role";


--
-- Name: TABLE "field_trip_payment_log"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."field_trip_payment_log" TO "anon";
GRANT ALL ON TABLE "public"."field_trip_payment_log" TO "authenticated";
GRANT ALL ON TABLE "public"."field_trip_payment_log" TO "service_role";


--
-- Name: TABLE "field_trip_payments"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."field_trip_payments" TO "anon";
GRANT ALL ON TABLE "public"."field_trip_payments" TO "authenticated";
GRANT ALL ON TABLE "public"."field_trip_payments" TO "service_role";


--
-- Name: TABLE "field_trip_students"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."field_trip_students" TO "anon";
GRANT ALL ON TABLE "public"."field_trip_students" TO "authenticated";
GRANT ALL ON TABLE "public"."field_trip_students" TO "service_role";


--
-- Name: TABLE "field_trip_vehicle_assignments"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."field_trip_vehicle_assignments" TO "anon";
GRANT ALL ON TABLE "public"."field_trip_vehicle_assignments" TO "authenticated";
GRANT ALL ON TABLE "public"."field_trip_vehicle_assignments" TO "service_role";


--
-- Name: TABLE "field_trips"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."field_trips" TO "anon";
GRANT ALL ON TABLE "public"."field_trips" TO "authenticated";
GRANT ALL ON TABLE "public"."field_trips" TO "service_role";


--
-- Name: TABLE "grade_check"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."grade_check" TO "anon";
GRANT ALL ON TABLE "public"."grade_check" TO "authenticated";
GRANT ALL ON TABLE "public"."grade_check" TO "service_role";


--
-- Name: TABLE "guardian_intake_campaigns"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."guardian_intake_campaigns" TO "anon";
GRANT ALL ON TABLE "public"."guardian_intake_campaigns" TO "authenticated";
GRANT ALL ON TABLE "public"."guardian_intake_campaigns" TO "service_role";


--
-- Name: TABLE "guardian_intake_submissions"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."guardian_intake_submissions" TO "anon";
GRANT ALL ON TABLE "public"."guardian_intake_submissions" TO "authenticated";
GRANT ALL ON TABLE "public"."guardian_intake_submissions" TO "service_role";


--
-- Name: TABLE "guardians"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."guardians" TO "anon";
GRANT ALL ON TABLE "public"."guardians" TO "authenticated";
GRANT ALL ON TABLE "public"."guardians" TO "service_role";


--
-- Name: TABLE "ic_data_gaps"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."ic_data_gaps" TO "anon";
GRANT ALL ON TABLE "public"."ic_data_gaps" TO "authenticated";
GRANT ALL ON TABLE "public"."ic_data_gaps" TO "service_role";


--
-- Name: TABLE "ic_field_diffs"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."ic_field_diffs" TO "anon";
GRANT ALL ON TABLE "public"."ic_field_diffs" TO "authenticated";
GRANT ALL ON TABLE "public"."ic_field_diffs" TO "service_role";


--
-- Name: TABLE "ic_reconciliation_candidates"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."ic_reconciliation_candidates" TO "anon";
GRANT ALL ON TABLE "public"."ic_reconciliation_candidates" TO "authenticated";
GRANT ALL ON TABLE "public"."ic_reconciliation_candidates" TO "service_role";


--
-- Name: TABLE "ic_sync_field_settings"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."ic_sync_field_settings" TO "anon";
GRANT ALL ON TABLE "public"."ic_sync_field_settings" TO "authenticated";
GRANT ALL ON TABLE "public"."ic_sync_field_settings" TO "service_role";


--
-- Name: TABLE "ic_sync_runs"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."ic_sync_runs" TO "anon";
GRANT ALL ON TABLE "public"."ic_sync_runs" TO "authenticated";
GRANT ALL ON TABLE "public"."ic_sync_runs" TO "service_role";


--
-- Name: TABLE "inventory_assignments"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."inventory_assignments" TO "anon";
GRANT ALL ON TABLE "public"."inventory_assignments" TO "authenticated";
GRANT ALL ON TABLE "public"."inventory_assignments" TO "service_role";


--
-- Name: TABLE "inventory_list_items"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."inventory_list_items" TO "anon";
GRANT ALL ON TABLE "public"."inventory_list_items" TO "authenticated";
GRANT ALL ON TABLE "public"."inventory_list_items" TO "service_role";


--
-- Name: TABLE "inventory_list_members"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."inventory_list_members" TO "anon";
GRANT ALL ON TABLE "public"."inventory_list_members" TO "authenticated";
GRANT ALL ON TABLE "public"."inventory_list_members" TO "service_role";


--
-- Name: TABLE "inventory_lists"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."inventory_lists" TO "anon";
GRANT ALL ON TABLE "public"."inventory_lists" TO "authenticated";
GRANT ALL ON TABLE "public"."inventory_lists" TO "service_role";


--
-- Name: TABLE "license_alert_log"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."license_alert_log" TO "anon";
GRANT ALL ON TABLE "public"."license_alert_log" TO "authenticated";
GRANT ALL ON TABLE "public"."license_alert_log" TO "service_role";


--
-- Name: TABLE "permission_audit_log"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."permission_audit_log" TO "anon";
GRANT ALL ON TABLE "public"."permission_audit_log" TO "authenticated";
GRANT ALL ON TABLE "public"."permission_audit_log" TO "service_role";


--
-- Name: TABLE "placement_assignments"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."placement_assignments" TO "anon";
GRANT ALL ON TABLE "public"."placement_assignments" TO "authenticated";
GRANT ALL ON TABLE "public"."placement_assignments" TO "service_role";


--
-- Name: TABLE "placement_audit_log"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."placement_audit_log" TO "anon";
GRANT ALL ON TABLE "public"."placement_audit_log" TO "authenticated";
GRANT ALL ON TABLE "public"."placement_audit_log" TO "service_role";


--
-- Name: TABLE "placement_flags"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."placement_flags" TO "anon";
GRANT ALL ON TABLE "public"."placement_flags" TO "authenticated";
GRANT ALL ON TABLE "public"."placement_flags" TO "service_role";


--
-- Name: TABLE "placement_session_notes"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."placement_session_notes" TO "anon";
GRANT ALL ON TABLE "public"."placement_session_notes" TO "authenticated";
GRANT ALL ON TABLE "public"."placement_session_notes" TO "service_role";


--
-- Name: TABLE "placement_session_teachers"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."placement_session_teachers" TO "anon";
GRANT ALL ON TABLE "public"."placement_session_teachers" TO "authenticated";
GRANT ALL ON TABLE "public"."placement_session_teachers" TO "service_role";


--
-- Name: TABLE "placement_sessions"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."placement_sessions" TO "anon";
GRANT ALL ON TABLE "public"."placement_sessions" TO "authenticated";
GRANT ALL ON TABLE "public"."placement_sessions" TO "service_role";


--
-- Name: TABLE "profiles"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."profiles" TO "anon";
GRANT ALL ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";


--
-- Name: TABLE "pto_balances"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."pto_balances" TO "anon";
GRANT ALL ON TABLE "public"."pto_balances" TO "authenticated";
GRANT ALL ON TABLE "public"."pto_balances" TO "service_role";


--
-- Name: TABLE "pto_ledger"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."pto_ledger" TO "anon";
GRANT ALL ON TABLE "public"."pto_ledger" TO "authenticated";
GRANT ALL ON TABLE "public"."pto_ledger" TO "service_role";


--
-- Name: TABLE "pto_requests"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."pto_requests" TO "anon";
GRANT ALL ON TABLE "public"."pto_requests" TO "authenticated";
GRANT ALL ON TABLE "public"."pto_requests" TO "service_role";


--
-- Name: TABLE "request_categories"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."request_categories" TO "anon";
GRANT ALL ON TABLE "public"."request_categories" TO "authenticated";
GRANT ALL ON TABLE "public"."request_categories" TO "service_role";


--
-- Name: TABLE "request_category_fields"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."request_category_fields" TO "anon";
GRANT ALL ON TABLE "public"."request_category_fields" TO "authenticated";
GRANT ALL ON TABLE "public"."request_category_fields" TO "service_role";


--
-- Name: TABLE "request_category_managers"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."request_category_managers" TO "anon";
GRANT ALL ON TABLE "public"."request_category_managers" TO "authenticated";
GRANT ALL ON TABLE "public"."request_category_managers" TO "service_role";


--
-- Name: TABLE "request_category_visibility"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."request_category_visibility" TO "anon";
GRANT ALL ON TABLE "public"."request_category_visibility" TO "authenticated";
GRANT ALL ON TABLE "public"."request_category_visibility" TO "service_role";


--
-- Name: TABLE "reservable_resources"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."reservable_resources" TO "anon";
GRANT ALL ON TABLE "public"."reservable_resources" TO "authenticated";
GRANT ALL ON TABLE "public"."reservable_resources" TO "service_role";


--
-- Name: TABLE "reservations"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."reservations" TO "anon";
GRANT ALL ON TABLE "public"."reservations" TO "authenticated";
GRANT ALL ON TABLE "public"."reservations" TO "service_role";


--
-- Name: TABLE "resource_document_bookmarks"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."resource_document_bookmarks" TO "anon";
GRANT ALL ON TABLE "public"."resource_document_bookmarks" TO "authenticated";
GRANT ALL ON TABLE "public"."resource_document_bookmarks" TO "service_role";


--
-- Name: TABLE "resource_document_categories"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."resource_document_categories" TO "anon";
GRANT ALL ON TABLE "public"."resource_document_categories" TO "authenticated";
GRANT ALL ON TABLE "public"."resource_document_categories" TO "service_role";


--
-- Name: TABLE "resource_documents"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."resource_documents" TO "anon";
GRANT ALL ON TABLE "public"."resource_documents" TO "authenticated";
GRANT ALL ON TABLE "public"."resource_documents" TO "service_role";


--
-- Name: TABLE "resource_groups"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."resource_groups" TO "anon";
GRANT ALL ON TABLE "public"."resource_groups" TO "authenticated";
GRANT ALL ON TABLE "public"."resource_groups" TO "service_role";


--
-- Name: TABLE "resource_time_blocks"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."resource_time_blocks" TO "anon";
GRANT ALL ON TABLE "public"."resource_time_blocks" TO "authenticated";
GRANT ALL ON TABLE "public"."resource_time_blocks" TO "service_role";


--
-- Name: TABLE "school_calendar_events"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."school_calendar_events" TO "anon";
GRANT ALL ON TABLE "public"."school_calendar_events" TO "authenticated";
GRANT ALL ON TABLE "public"."school_calendar_events" TO "service_role";


--
-- Name: TABLE "school_domains"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."school_domains" TO "anon";
GRANT ALL ON TABLE "public"."school_domains" TO "authenticated";
GRANT ALL ON TABLE "public"."school_domains" TO "service_role";


--
-- Name: TABLE "school_modules"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."school_modules" TO "anon";
GRANT ALL ON TABLE "public"."school_modules" TO "authenticated";
GRANT ALL ON TABLE "public"."school_modules" TO "service_role";


--
-- Name: TABLE "school_pto_types"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."school_pto_types" TO "anon";
GRANT ALL ON TABLE "public"."school_pto_types" TO "authenticated";
GRANT ALL ON TABLE "public"."school_pto_types" TO "service_role";


--
-- Name: TABLE "school_settings"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."school_settings" TO "anon";
GRANT ALL ON TABLE "public"."school_settings" TO "authenticated";
GRANT ALL ON TABLE "public"."school_settings" TO "service_role";


--
-- Name: TABLE "school_student_sequences"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."school_student_sequences" TO "anon";
GRANT ALL ON TABLE "public"."school_student_sequences" TO "authenticated";
GRANT ALL ON TABLE "public"."school_student_sequences" TO "service_role";


--
-- Name: TABLE "schools"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."schools" TO "anon";
GRANT ALL ON TABLE "public"."schools" TO "authenticated";
GRANT ALL ON TABLE "public"."schools" TO "service_role";


--
-- Name: TABLE "staff_groups"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."staff_groups" TO "anon";
GRANT ALL ON TABLE "public"."staff_groups" TO "authenticated";
GRANT ALL ON TABLE "public"."staff_groups" TO "service_role";


--
-- Name: TABLE "staff_license_ceus"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."staff_license_ceus" TO "anon";
GRANT ALL ON TABLE "public"."staff_license_ceus" TO "authenticated";
GRANT ALL ON TABLE "public"."staff_license_ceus" TO "service_role";


--
-- Name: TABLE "staff_license_files"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."staff_license_files" TO "anon";
GRANT ALL ON TABLE "public"."staff_license_files" TO "authenticated";
GRANT ALL ON TABLE "public"."staff_license_files" TO "service_role";


--
-- Name: TABLE "staff_license_history"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."staff_license_history" TO "anon";
GRANT ALL ON TABLE "public"."staff_license_history" TO "authenticated";
GRANT ALL ON TABLE "public"."staff_license_history" TO "service_role";


--
-- Name: TABLE "staff_licenses"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."staff_licenses" TO "anon";
GRANT ALL ON TABLE "public"."staff_licenses" TO "authenticated";
GRANT ALL ON TABLE "public"."staff_licenses" TO "service_role";


--
-- Name: TABLE "staff_request_responses"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."staff_request_responses" TO "anon";
GRANT ALL ON TABLE "public"."staff_request_responses" TO "authenticated";
GRANT ALL ON TABLE "public"."staff_request_responses" TO "service_role";


--
-- Name: TABLE "staff_requests"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."staff_requests" TO "anon";
GRANT ALL ON TABLE "public"."staff_requests" TO "authenticated";
GRANT ALL ON TABLE "public"."staff_requests" TO "service_role";


--
-- Name: TABLE "student_placement_flags"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."student_placement_flags" TO "anon";
GRANT ALL ON TABLE "public"."student_placement_flags" TO "authenticated";
GRANT ALL ON TABLE "public"."student_placement_flags" TO "service_role";


--
-- Name: TABLE "student_promotion_log"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."student_promotion_log" TO "anon";
GRANT ALL ON TABLE "public"."student_promotion_log" TO "authenticated";
GRANT ALL ON TABLE "public"."student_promotion_log" TO "service_role";


--
-- Name: TABLE "students"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."students" TO "anon";
GRANT ALL ON TABLE "public"."students" TO "authenticated";
GRANT ALL ON TABLE "public"."students" TO "service_role";


--
-- Name: TABLE "substitute_assignments"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."substitute_assignments" TO "anon";
GRANT ALL ON TABLE "public"."substitute_assignments" TO "authenticated";
GRANT ALL ON TABLE "public"."substitute_assignments" TO "service_role";


--
-- Name: TABLE "substitutes"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."substitutes" TO "anon";
GRANT ALL ON TABLE "public"."substitutes" TO "authenticated";
GRANT ALL ON TABLE "public"."substitutes" TO "service_role";


--
-- Name: TABLE "supervisor_candidates"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."supervisor_candidates" TO "anon";
GRANT ALL ON TABLE "public"."supervisor_candidates" TO "authenticated";
GRANT ALL ON TABLE "public"."supervisor_candidates" TO "service_role";


--
-- Name: TABLE "v_pending_cancellation_days"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."v_pending_cancellation_days" TO "anon";
GRANT ALL ON TABLE "public"."v_pending_cancellation_days" TO "authenticated";
GRANT ALL ON TABLE "public"."v_pending_cancellation_days" TO "service_role";


--
-- Name: TABLE "v_pto_coverage_days_approved"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."v_pto_coverage_days_approved" TO "anon";
GRANT ALL ON TABLE "public"."v_pto_coverage_days_approved" TO "authenticated";
GRANT ALL ON TABLE "public"."v_pto_coverage_days_approved" TO "service_role";


--
-- Name: TABLE "v_pending_coverage_days"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."v_pending_coverage_days" TO "anon";
GRANT ALL ON TABLE "public"."v_pending_coverage_days" TO "authenticated";
GRANT ALL ON TABLE "public"."v_pending_coverage_days" TO "service_role";


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: postgres
--

ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: supabase_admin
--

-- ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
-- ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
-- ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
-- ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: postgres
--

ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: supabase_admin
--

-- ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
-- ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
-- ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
-- ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: postgres
--

ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: supabase_admin
--

-- ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
-- ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
-- ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
-- ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";


--
-- PostgreSQL database dump complete
--

-- \unrestrict R8XqRlAFK6vJqOKtwtgdaGgMqEF9KdOsxeGbmDh1pbnXfdExSWRJscB8q6yhfAf

