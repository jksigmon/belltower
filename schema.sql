--
-- PostgreSQL database dump
--

\restrict OjdQirAiMrOguwRQuNVQO2y45hoAqHRTkUVfp5g1d7wP7RYTwZF6sUDYTWXPHOu

-- Dumped from database version 17.6
-- Dumped by pg_dump version 18.3

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: call_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.call_type AS ENUM (
    'FAMILY',
    'BUS',
    'ALL'
);


--
-- Name: carline_call_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.carline_call_status AS ENUM (
    'WAITING',
    'CALLED',
    'RECALLED',
    'LOADED'
);


--
-- Name: pto_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.pto_status AS ENUM (
    'PENDING',
    'APPROVED',
    'DENIED',
    'CANCEL_REQUESTED',
    'CANCELLED',
    'RESCIND_REQUESTED',
    'RESCINDED'
);


--
-- Name: pto_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.pto_type AS ENUM (
    'SICK',
    'VACATION',
    'PERSONAL',
    'PROFESSIONAL',
    'JURY DUTY',
    'BEREAVEMENT'
);


--
-- Name: role_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.role_type AS ENUM (
    'admin',
    'staff',
    'front office'
);


--
-- Name: TYPE role_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TYPE public.role_type IS 'Role Types';


--
-- Name: assign_student_number(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.assign_student_number() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
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


--
-- Name: claim_or_create_profile_for_user(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.claim_or_create_profile_for_user() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
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


--
-- Name: claim_profile_for_user(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.claim_profile_for_user() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
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


--
-- Name: create_profile_for_new_user(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_profile_for_new_user() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
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


--
-- Name: current_user_can_manage_access(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.current_user_can_manage_access() RETURNS boolean
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    SET row_security TO 'off'
    AS $$
  select
    coalesce(
      bool_or(can_manage_access or is_superadmin),
      false
    )
  from profiles
  where user_id = auth.uid();
$$;


--
-- Name: current_user_school_id(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.current_user_school_id() RETURNS uuid
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    SET row_security TO 'off'
    AS $$
  select school_id
  from profiles
  where user_id = auth.uid()
  limit 1;
$$;


--
-- Name: enforce_supervisor_is_pto_approver(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_supervisor_is_pto_approver() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  -- Allow null supervisor
  if new.supervisor_id is null then
    return new;
  end if;

  -- Check supervisor has a profile with PTO approval
  if not exists (
    select 1
    from profiles p
    where p.employee_id = new.supervisor_id
      and p.can_approve_pto = true
  ) then
    raise exception
      'Supervisor must have PTO approval access';
  end if;

  return new;
end;
$$;


--
-- Name: enforce_fallback_approver_has_pto_access(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_fallback_approver_has_pto_access() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if new.is_fallback_approver = true and new.can_approve_pto = false then
    raise exception
      'Fallback approver must also have PTO approval access';
  end if;

  return new;
end;
$$;


--
-- Name: handle_new_auth_user(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.handle_new_auth_user() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
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


--
-- Name: handle_pto_ledger_insert(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.handle_pto_ledger_insert() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    SET row_security TO 'off'
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


--
-- Name: handle_pto_status_change(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.handle_pto_status_change() RETURNS trigger
    LANGUAGE plpgsql
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


--
-- Name: notify_pto_event(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_pto_event() RETURNS trigger
    LANGUAGE plpgsql
    AS $$BEGIN
  PERFORM
    net.http_post(
      url := 'https://xrhwjjkxlshfarlxuxsa.functions.supabase.co/send_pto_notifications',
      headers := jsonb_build_object(
        'Content-Type', 'application/json'
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


--
-- Name: rls_auto_enable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rls_auto_enable() RETURNS event_trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
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


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: bulk_upload_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bulk_upload_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    uploaded_by uuid NOT NULL,
    uploaded_at timestamp with time zone DEFAULT now(),
    mode text NOT NULL,
    summary jsonb,
    filename text,
    school_id uuid,
    selected_sheets text[],
    error_count integer DEFAULT 0 NOT NULL,
    blocking_errors boolean DEFAULT false NOT NULL,
    rows jsonb
);


--
-- Name: bus_groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bus_groups (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id uuid NOT NULL,
    name text NOT NULL,
    route_number text
);


--
-- Name: carline_calls; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.carline_calls (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id uuid NOT NULL,
    carline_event_id uuid NOT NULL,
    student_id uuid NOT NULL,
    family_id uuid,
    status public.carline_call_status DEFAULT 'WAITING'::public.carline_call_status NOT NULL,
    called_by_user_id uuid,
    called_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    call_type text DEFAULT ''::text,
    recalled_at timestamp with time zone,
    loaded_at timestamp with time zone,
    called_by_profile_id uuid
);


--
-- Name: carline_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.carline_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id uuid NOT NULL,
    name text,
    event_date date DEFAULT CURRENT_DATE NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    status text,
    closed_at timestamp with time zone,
    closed_by_user_id uuid,
    created_by_profile_id uuid,
    closed_by_profile_id uuid
);


--
-- Name: carline_tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.carline_tags (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id uuid NOT NULL,
    family_id uuid NOT NULL,
    tag_number text NOT NULL,
    active boolean DEFAULT true NOT NULL
);


--
-- Name: employee_pto_policies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.employee_pto_policies (
    employee_id uuid NOT NULL,
    pto_type text NOT NULL,
    annual_hours numeric(6,2) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT annual_hours_non_negative CHECK ((annual_hours >= (0)::numeric)),
    CONSTRAINT employee_pto_policies_annual_hours_check CHECK ((annual_hours >= (0)::numeric))
);


--
-- Name: employees; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.employees (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id uuid NOT NULL,
    user_id uuid,
    first_name text NOT NULL,
    last_name text NOT NULL,
    email text,
    "position" text,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    pto_allotment_month integer DEFAULT 1,
    supervisor_id uuid,
    profile_id uuid
);


--
-- Name: families; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.families (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id uuid NOT NULL,
    family_name text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    active boolean DEFAULT true NOT NULL,
    carline_tag_number text NOT NULL
);


--
-- Name: guardians; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.guardians (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id uuid NOT NULL,
    family_id uuid NOT NULL,
    first_name text,
    last_name text,
    phone text,
    email text,
    active boolean DEFAULT true NOT NULL
);


--
-- Name: profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.profiles (
    user_id uuid,
    school_id uuid,
    role text NOT NULL,
    display_name text,
    email text,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    is_superadmin boolean DEFAULT false NOT NULL,
    employee_id uuid,
    can_view_carline boolean DEFAULT false NOT NULL,
    can_view_pto_calendar boolean DEFAULT false NOT NULL,
    can_review_pto boolean DEFAULT false NOT NULL,
    can_approve_pto boolean DEFAULT false NOT NULL,
    is_fallback_approver boolean DEFAULT false NOT NULL,
    can_adjust_pto boolean DEFAULT false NOT NULL,
    can_bulk_upload boolean DEFAULT false NOT NULL,
    can_manage_guardians boolean DEFAULT false NOT NULL,
    can_login boolean DEFAULT false NOT NULL,
    can_access_admin boolean DEFAULT false NOT NULL,
    can_generate_pto_reports boolean DEFAULT false NOT NULL,
    can_manage_access boolean DEFAULT false NOT NULL,
    can_manage_staff boolean DEFAULT false NOT NULL,
    can_manage_families boolean DEFAULT false NOT NULL,
    can_manage_substitutes boolean DEFAULT false NOT NULL,
    can_manage_students boolean DEFAULT false NOT NULL,
    can_manage_bus_groups boolean DEFAULT false NOT NULL,
    can_export_data boolean DEFAULT false NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL
);


--
-- Name: pto_balances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pto_balances (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id uuid NOT NULL,
    employee_id uuid NOT NULL,
    pto_type public.pto_type NOT NULL,
    balance_hours numeric(6,2) DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: pto_ledger; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pto_ledger (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id uuid NOT NULL,
    employee_id uuid NOT NULL,
    pto_type public.pto_type NOT NULL,
    delta_hours numeric(6,2) NOT NULL,
    reason text NOT NULL,
    related_request_id uuid,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: pto_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pto_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id uuid NOT NULL,
    employee_id uuid NOT NULL,
    pto_type public.pto_type NOT NULL,
    start_date date NOT NULL,
    end_date date NOT NULL,
    partial_day boolean DEFAULT false NOT NULL,
    partial_hours numeric(4,2),
    notes text,
    status public.pto_status DEFAULT 'PENDING'::public.pto_status NOT NULL,
    submitted_at timestamp with time zone DEFAULT now() NOT NULL,
    decided_at timestamp with time zone,
    decided_by uuid,
    start_time time without time zone,
    end_time time without time zone,
    requested_hours numeric NOT NULL,
    requested_duration_label text,
    needs_sub_coverage boolean DEFAULT false NOT NULL,
    sub_coverage_notified_at timestamp with time zone,
    sub_coverage_notified_by uuid,
    CONSTRAINT chk_dates_valid CHECK ((end_date >= start_date))
);


--
-- Name: school_domains; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.school_domains (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id uuid NOT NULL,
    domain text NOT NULL
);


--
-- Name: school_modules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.school_modules (
    school_id uuid NOT NULL,
    module text NOT NULL,
    enabled boolean DEFAULT false NOT NULL
);


--
-- Name: school_pto_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.school_pto_types (
    school_id uuid NOT NULL,
    pto_type text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    counts_against_balance boolean DEFAULT true NOT NULL
);


--
-- Name: school_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.school_settings (
    school_id uuid NOT NULL,
    workday_hours numeric DEFAULT 8 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: school_student_sequences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.school_student_sequences (
    school_id uuid NOT NULL,
    next_number integer DEFAULT 1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: schools; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schools (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    short_name text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    calendar_ics_token uuid DEFAULT gen_random_uuid() NOT NULL,
    email_domain text
);


--
-- Name: students; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.students (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id uuid NOT NULL,
    family_id uuid,
    student_number text,
    first_name text NOT NULL,
    last_name text NOT NULL,
    grade_level text,
    homeroom_teacher text,
    bus_group_id uuid,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    homeroom_teacher_id uuid
);


--
-- Name: substitute_assignments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.substitute_assignments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id uuid NOT NULL,
    substitute_id uuid,
    employee_id uuid,
    start_date date NOT NULL,
    end_date date NOT NULL,
    start_time time without time zone,
    end_time time without time zone,
    reason text,
    status text DEFAULT 'scheduled'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    pto_request_id uuid,
    covered_employee_id uuid,
    CONSTRAINT substitute_assignments_exactly_one_coverer CHECK (((substitute_id IS NULL) <> (employee_id IS NULL))),
    CONSTRAINT substitute_assignments_has_covered_target CHECK (((pto_request_id IS NOT NULL) OR (covered_employee_id IS NOT NULL)))
);


--
-- Name: substitutes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.substitutes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id uuid NOT NULL,
    first_name text NOT NULL,
    last_name text NOT NULL,
    email text,
    phone text,
    notes text,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: supervisor_candidates; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.supervisor_candidates AS
 SELECT e.id,
    e.first_name,
    e.last_name,
    e.school_id
   FROM (public.profiles p
     JOIN public.employees e ON ((e.id = p.employee_id)))
  WHERE ((p.can_approve_pto = true) AND (e.active = true));


--
-- Name: v_pending_cancellation_days; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_pending_cancellation_days AS
 SELECT pr.id AS pto_request_id,
    pr.school_id,
    pr.employee_id AS out_employee_id,
    e.first_name AS out_first_name,
    e.last_name AS out_last_name,
    pr.pto_type,
    pr.notes,
    pr.status,
    (gs.gs)::date AS coverage_date,
    sa.id AS assignment_id,
    sa.substitute_id,
    sa.employee_id AS covering_employee_id,
    sa.start_time,
    sa.end_time,
    sa.reason,
    sa.status AS assignment_status
   FROM (((public.pto_requests pr
     JOIN public.employees e ON ((e.id = pr.employee_id)))
     CROSS JOIN LATERAL generate_series((pr.start_date)::timestamp with time zone, (pr.end_date)::timestamp with time zone, '1 day'::interval) gs(gs))
     JOIN public.substitute_assignments sa ON (((sa.pto_request_id = pr.id) AND (sa.start_date = (gs.gs)::date) AND (sa.end_date = (gs.gs)::date) AND (sa.status = 'scheduled'::text))))
  WHERE ((pr.needs_sub_coverage = true) AND (pr.status = 'CANCELLED'::public.pto_status) AND (EXTRACT(dow FROM gs.gs) <> ALL (ARRAY[(0)::numeric, (6)::numeric])) AND ((gs.gs)::date > CURRENT_DATE));


--
-- Name: v_pto_coverage_days_approved; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_pto_coverage_days_approved AS
 SELECT pr.id AS pto_request_id,
    pr.school_id,
    pr.employee_id AS out_employee_id,
    e.first_name AS out_first_name,
    e.last_name AS out_last_name,
    pr.pto_type,
    pr.notes,
    pr.status,
    (gs.gs)::date AS coverage_date,
        CASE
            WHEN ((pr.start_date = pr.end_date) AND (pr.partial_day = true)) THEN pr.start_time
            ELSE NULL::time without time zone
        END AS start_time,
        CASE
            WHEN ((pr.start_date = pr.end_date) AND (pr.partial_day = true)) THEN pr.end_time
            ELSE NULL::time without time zone
        END AS end_time
   FROM ((public.pto_requests pr
     JOIN public.employees e ON ((e.id = pr.employee_id)))
     CROSS JOIN LATERAL generate_series((pr.start_date)::timestamp with time zone, (pr.end_date)::timestamp with time zone, '1 day'::interval) gs(gs))
  WHERE ((pr.needs_sub_coverage = true) AND (pr.status = 'APPROVED'::public.pto_status) AND (EXTRACT(dow FROM gs.gs) <> ALL (ARRAY[(0)::numeric, (6)::numeric])));


--
-- Name: v_pending_coverage_days; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_pending_coverage_days AS
 SELECT v.pto_request_id,
    v.school_id,
    v.out_employee_id,
    v.out_first_name,
    v.out_last_name,
    v.pto_type,
    v.notes,
    v.status,
    v.coverage_date,
    v.start_time,
    v.end_time,
    sa.id AS assignment_id
   FROM (public.v_pto_coverage_days_approved v
     LEFT JOIN public.substitute_assignments sa ON (((sa.pto_request_id = v.pto_request_id) AND (sa.start_date = v.coverage_date) AND (sa.end_date = v.coverage_date) AND (sa.status = 'scheduled'::text))))
  WHERE ((sa.id IS NULL) AND (v.coverage_date >= CURRENT_DATE));


--
-- Name: bulk_upload_logs bulk_upload_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bulk_upload_logs
    ADD CONSTRAINT bulk_upload_logs_pkey PRIMARY KEY (id);


--
-- Name: bus_groups bus_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bus_groups
    ADD CONSTRAINT bus_groups_pkey PRIMARY KEY (id);


--
-- Name: carline_calls carline_calls_event_student_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.carline_calls
    ADD CONSTRAINT carline_calls_event_student_unique UNIQUE (carline_event_id, student_id);


--
-- Name: carline_calls carline_calls_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.carline_calls
    ADD CONSTRAINT carline_calls_pkey PRIMARY KEY (id);


--
-- Name: carline_events carline_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.carline_events
    ADD CONSTRAINT carline_events_pkey PRIMARY KEY (id);


--
-- Name: carline_tags carline_tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.carline_tags
    ADD CONSTRAINT carline_tags_pkey PRIMARY KEY (id);


--
-- Name: employee_pto_policies employee_pto_policies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_pto_policies
    ADD CONSTRAINT employee_pto_policies_pkey PRIMARY KEY (employee_id, pto_type);


--
-- Name: employees employees_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_pkey PRIMARY KEY (id);


--
-- Name: families families_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.families
    ADD CONSTRAINT families_pkey PRIMARY KEY (id);


--
-- Name: guardians guardians_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guardians
    ADD CONSTRAINT guardians_pkey PRIMARY KEY (id);


--
-- Name: guardians guardians_unique_per_family; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guardians
    ADD CONSTRAINT guardians_unique_per_family UNIQUE (family_id, first_name, last_name, email);


--
-- Name: profiles profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);


--
-- Name: profiles profiles_unique_email; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_unique_email UNIQUE (email);


--
-- Name: pto_balances pto_balances_employee_type_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pto_balances
    ADD CONSTRAINT pto_balances_employee_type_unique UNIQUE (employee_id, pto_type);


--
-- Name: pto_balances pto_balances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pto_balances
    ADD CONSTRAINT pto_balances_pkey PRIMARY KEY (id);


--
-- Name: pto_ledger pto_ledger_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pto_ledger
    ADD CONSTRAINT pto_ledger_pkey PRIMARY KEY (id);


--
-- Name: pto_requests pto_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pto_requests
    ADD CONSTRAINT pto_requests_pkey PRIMARY KEY (id);


--
-- Name: school_domains school_domains_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_domains
    ADD CONSTRAINT school_domains_pkey PRIMARY KEY (id);


--
-- Name: school_modules school_modules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_modules
    ADD CONSTRAINT school_modules_pkey PRIMARY KEY (school_id, module);


--
-- Name: school_pto_types school_pto_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_pto_types
    ADD CONSTRAINT school_pto_types_pkey PRIMARY KEY (school_id, pto_type);


--
-- Name: school_settings school_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_settings
    ADD CONSTRAINT school_settings_pkey PRIMARY KEY (school_id);


--
-- Name: school_student_sequences school_student_sequences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_student_sequences
    ADD CONSTRAINT school_student_sequences_pkey PRIMARY KEY (school_id);


--
-- Name: schools schools_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schools
    ADD CONSTRAINT schools_pkey PRIMARY KEY (id);


--
-- Name: students students_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.students
    ADD CONSTRAINT students_pkey PRIMARY KEY (id);


--
-- Name: substitute_assignments substitute_assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.substitute_assignments
    ADD CONSTRAINT substitute_assignments_pkey PRIMARY KEY (id);


--
-- Name: substitutes substitutes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.substitutes
    ADD CONSTRAINT substitutes_pkey PRIMARY KEY (id);


--
-- Name: pto_balances uq_balance_per_emp_type; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pto_balances
    ADD CONSTRAINT uq_balance_per_emp_type UNIQUE (employee_id, pto_type);


--
-- Name: employees uq_employee_email_per_school; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employees
    ADD CONSTRAINT uq_employee_email_per_school UNIQUE (school_id, email);


--
-- Name: school_domains uq_school_domain; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_domains
    ADD CONSTRAINT uq_school_domain UNIQUE (domain);


--
-- Name: students uq_student_number_per_school; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.students
    ADD CONSTRAINT uq_student_number_per_school UNIQUE (school_id, student_number);


--
-- Name: carline_tags uq_tag_per_school; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.carline_tags
    ADD CONSTRAINT uq_tag_per_school UNIQUE (school_id, tag_number);


--
-- Name: bus_groups_school_id_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX bus_groups_school_id_name_idx ON public.bus_groups USING btree (school_id, name);


--
-- Name: carline_calls_event_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX carline_calls_event_status_idx ON public.carline_calls USING btree (carline_event_id, status);


--
-- Name: carline_calls_family_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX carline_calls_family_idx ON public.carline_calls USING btree (family_id);


--
-- Name: carline_calls_school_id_event_id_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX carline_calls_school_id_event_id_status_idx ON public.carline_calls USING btree (school_id, carline_event_id, status);


--
-- Name: carline_calls_student_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX carline_calls_student_idx ON public.carline_calls USING btree (student_id);


--
-- Name: carline_events_school_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX carline_events_school_date_idx ON public.carline_events USING btree (school_id, event_date);


--
-- Name: carline_events_school_id_event_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX carline_events_school_id_event_date_idx ON public.carline_events USING btree (school_id, event_date);


--
-- Name: carline_tags_school_id_family_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX carline_tags_school_id_family_id_idx ON public.carline_tags USING btree (school_id, family_id);


--
-- Name: families_school_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX families_school_id_idx ON public.families USING btree (school_id);


--
-- Name: families_school_tag_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX families_school_tag_unique ON public.families USING btree (school_id, carline_tag_number);


--
-- Name: guardians_school_id_family_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX guardians_school_id_family_id_idx ON public.guardians USING btree (school_id, family_id);


--
-- Name: idx_sub_assign_pto_request_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sub_assign_pto_request_id ON public.substitute_assignments USING btree (pto_request_id);


--
-- Name: idx_sub_assign_school_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sub_assign_school_date ON public.substitute_assignments USING btree (school_id, start_date);


--
-- Name: profiles_id_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX profiles_id_unique ON public.profiles USING btree (id);


--
-- Name: profiles_role_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX profiles_role_idx ON public.profiles USING btree (role);


--
-- Name: profiles_school_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX profiles_school_id_idx ON public.profiles USING btree (school_id);


--
-- Name: profiles_unique_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX profiles_unique_user_id ON public.profiles USING btree (user_id) WHERE (user_id IS NOT NULL);


--
-- Name: pto_balances_school_id_employee_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pto_balances_school_id_employee_id_idx ON public.pto_balances USING btree (school_id, employee_id);


--
-- Name: pto_ledger_school_id_employee_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pto_ledger_school_id_employee_id_created_at_idx ON public.pto_ledger USING btree (school_id, employee_id, created_at);


--
-- Name: pto_requests_school_id_employee_id_status_start_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pto_requests_school_id_employee_id_status_start_date_idx ON public.pto_requests USING btree (school_id, employee_id, status, start_date);


--
-- Name: students_family_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX students_family_id_idx ON public.students USING btree (family_id);


--
-- Name: students_school_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX students_school_id_idx ON public.students USING btree (school_id);


--
-- Name: students_unique_identity; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX students_unique_identity ON public.students USING btree (school_id, family_id, lower(first_name), lower(last_name));


--
-- Name: students_unique_per_school; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX students_unique_per_school ON public.students USING btree (school_id, student_number);


--
-- Name: uniq_pto_annual_allotment; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_pto_annual_allotment ON public.pto_ledger USING btree (employee_id, pto_type, reason) WHERE (reason ~~ 'ANNUAL_ALLOTMENT_%'::text);


--
-- Name: uq_sub_assign_pto_day; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_sub_assign_pto_day ON public.substitute_assignments USING btree (pto_request_id, start_date) WHERE ((pto_request_id IS NOT NULL) AND (status = 'scheduled'::text));


--
-- Name: students before_insert_assign_student_number; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER before_insert_assign_student_number BEFORE INSERT ON public.students FOR EACH ROW EXECUTE FUNCTION public.assign_student_number();


--
-- Name: employees employees_supervisor_pto_check; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER employees_supervisor_pto_check BEFORE INSERT OR UPDATE OF supervisor_id ON public.employees FOR EACH ROW EXECUTE FUNCTION public.enforce_supervisor_is_pto_approver();


--
-- Name: profiles profiles_fallback_approver_check; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER profiles_fallback_approver_check BEFORE INSERT OR UPDATE OF is_fallback_approver, can_approve_pto ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.enforce_fallback_approver_has_pto_access();


--
-- Name: pto_requests pto_notification_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER pto_notification_trigger AFTER INSERT OR UPDATE OF status ON public.pto_requests FOR EACH ROW EXECUTE FUNCTION public.notify_pto_event();


--
-- Name: pto_ledger trg_pto_ledger_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_pto_ledger_insert AFTER INSERT ON public.pto_ledger FOR EACH ROW EXECUTE FUNCTION public.handle_pto_ledger_insert();


--
-- Name: pto_requests trg_pto_status_change; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_pto_status_change AFTER UPDATE ON public.pto_requests FOR EACH ROW EXECUTE FUNCTION public.handle_pto_status_change();


--
-- Name: bus_groups bus_groups_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bus_groups
    ADD CONSTRAINT bus_groups_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: carline_calls carline_calls_called_by_profile_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.carline_calls
    ADD CONSTRAINT carline_calls_called_by_profile_fkey FOREIGN KEY (called_by_profile_id) REFERENCES public.profiles(id);


--
-- Name: carline_calls carline_calls_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.carline_calls
    ADD CONSTRAINT carline_calls_event_id_fkey FOREIGN KEY (carline_event_id) REFERENCES public.carline_events(id) ON DELETE CASCADE;


--
-- Name: carline_calls carline_calls_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.carline_calls
    ADD CONSTRAINT carline_calls_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.families(id) ON DELETE SET NULL;


--
-- Name: carline_calls carline_calls_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.carline_calls
    ADD CONSTRAINT carline_calls_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: carline_calls carline_calls_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.carline_calls
    ADD CONSTRAINT carline_calls_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE CASCADE;


--
-- Name: carline_events carline_events_closed_by_profile_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.carline_events
    ADD CONSTRAINT carline_events_closed_by_profile_fkey FOREIGN KEY (closed_by_profile_id) REFERENCES public.profiles(id);


--
-- Name: carline_events carline_events_created_by_profile_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.carline_events
    ADD CONSTRAINT carline_events_created_by_profile_fkey FOREIGN KEY (created_by_profile_id) REFERENCES public.profiles(id);


--
-- Name: carline_events carline_events_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.carline_events
    ADD CONSTRAINT carline_events_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: carline_tags carline_tags_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.carline_tags
    ADD CONSTRAINT carline_tags_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.families(id) ON DELETE CASCADE;


--
-- Name: carline_tags carline_tags_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.carline_tags
    ADD CONSTRAINT carline_tags_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: employee_pto_policies employee_pto_policies_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_pto_policies
    ADD CONSTRAINT employee_pto_policies_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE;


--
-- Name: employees employees_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.profiles(id);


--
-- Name: employees employees_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: employees employees_supervisor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_supervisor_id_fkey FOREIGN KEY (supervisor_id) REFERENCES public.employees(id);


--
-- Name: families families_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.families
    ADD CONSTRAINT families_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: students fk_student_bus_group; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.students
    ADD CONSTRAINT fk_student_bus_group FOREIGN KEY (bus_group_id) REFERENCES public.bus_groups(id) ON DELETE SET NULL;


--
-- Name: guardians guardians_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guardians
    ADD CONSTRAINT guardians_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.families(id) ON DELETE CASCADE;


--
-- Name: guardians guardians_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guardians
    ADD CONSTRAINT guardians_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: profiles profiles_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE SET NULL;


--
-- Name: profiles profiles_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE SET NULL;


--
-- Name: profiles profiles_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: pto_balances pto_balances_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pto_balances
    ADD CONSTRAINT pto_balances_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE;


--
-- Name: pto_balances pto_balances_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pto_balances
    ADD CONSTRAINT pto_balances_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: pto_ledger pto_ledger_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pto_ledger
    ADD CONSTRAINT pto_ledger_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.employees(id) ON DELETE SET NULL;


--
-- Name: pto_ledger pto_ledger_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pto_ledger
    ADD CONSTRAINT pto_ledger_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE;


--
-- Name: pto_ledger pto_ledger_related_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pto_ledger
    ADD CONSTRAINT pto_ledger_related_request_id_fkey FOREIGN KEY (related_request_id) REFERENCES public.pto_requests(id);


--
-- Name: pto_ledger pto_ledger_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pto_ledger
    ADD CONSTRAINT pto_ledger_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: pto_requests pto_requests_decided_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pto_requests
    ADD CONSTRAINT pto_requests_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES public.employees(id) ON DELETE SET NULL;


--
-- Name: pto_requests pto_requests_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pto_requests
    ADD CONSTRAINT pto_requests_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE;


--
-- Name: pto_requests pto_requests_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pto_requests
    ADD CONSTRAINT pto_requests_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: pto_requests pto_requests_sub_coverage_notified_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pto_requests
    ADD CONSTRAINT pto_requests_sub_coverage_notified_by_fkey FOREIGN KEY (sub_coverage_notified_by) REFERENCES public.employees(id);


--
-- Name: school_domains school_domains_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_domains
    ADD CONSTRAINT school_domains_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: school_modules school_modules_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_modules
    ADD CONSTRAINT school_modules_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: school_pto_types school_pto_types_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_pto_types
    ADD CONSTRAINT school_pto_types_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: school_settings school_settings_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_settings
    ADD CONSTRAINT school_settings_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: students students_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.students
    ADD CONSTRAINT students_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.families(id) ON DELETE SET NULL;


--
-- Name: students students_homeroom_teacher_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.students
    ADD CONSTRAINT students_homeroom_teacher_fkey FOREIGN KEY (homeroom_teacher_id) REFERENCES public.employees(id);


--
-- Name: students students_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.students
    ADD CONSTRAINT students_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: substitute_assignments substitute_assignments_covered_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.substitute_assignments
    ADD CONSTRAINT substitute_assignments_covered_employee_id_fkey FOREIGN KEY (covered_employee_id) REFERENCES public.employees(id);


--
-- Name: substitute_assignments substitute_assignments_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.substitute_assignments
    ADD CONSTRAINT substitute_assignments_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id);


--
-- Name: substitute_assignments substitute_assignments_pto_request_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.substitute_assignments
    ADD CONSTRAINT substitute_assignments_pto_request_fkey FOREIGN KEY (pto_request_id) REFERENCES public.pto_requests(id);


--
-- Name: substitute_assignments substitute_assignments_pto_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.substitute_assignments
    ADD CONSTRAINT substitute_assignments_pto_request_id_fkey FOREIGN KEY (pto_request_id) REFERENCES public.pto_requests(id);


--
-- Name: substitute_assignments substitute_assignments_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.substitute_assignments
    ADD CONSTRAINT substitute_assignments_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: substitute_assignments substitute_assignments_substitute_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.substitute_assignments
    ADD CONSTRAINT substitute_assignments_substitute_id_fkey FOREIGN KEY (substitute_id) REFERENCES public.substitutes(id) ON DELETE CASCADE;


--
-- Name: substitutes substitutes_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.substitutes
    ADD CONSTRAINT substitutes_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: guardians Admins can insert guardians; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can insert guardians" ON public.guardians FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.user_id = auth.uid()) AND (profiles.school_id = guardians.school_id) AND (profiles.can_manage_guardians = true)))));


--
-- Name: employee_pto_policies Admins can manage PTO policies for their school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can manage PTO policies for their school" ON public.employee_pto_policies USING ((EXISTS ( SELECT 1
   FROM (public.employees e
     JOIN public.profiles p ON ((p.user_id = auth.uid())))
  WHERE ((e.id = employee_pto_policies.employee_id) AND (e.school_id = p.school_id) AND (p.can_adjust_pto = true))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM (public.employees e
     JOIN public.profiles p ON ((p.user_id = auth.uid())))
  WHERE ((e.id = employee_pto_policies.employee_id) AND (e.school_id = p.school_id) AND (p.can_adjust_pto = true)))));


--
-- Name: employee_pto_policies Admins can read PTO policies for their school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can read PTO policies for their school" ON public.employee_pto_policies FOR SELECT USING ((EXISTS ( SELECT 1
   FROM (public.employees e
     JOIN public.profiles p ON ((p.user_id = auth.uid())))
  WHERE ((e.id = employee_pto_policies.employee_id) AND (e.school_id = p.school_id)))));


--
-- Name: school_modules Admins can read modules; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can read modules" ON public.school_modules FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.user_id = auth.uid()) AND (p.school_id = school_modules.school_id)))));


--
-- Name: profiles Admins can read users in their school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can read users in their school" ON public.profiles FOR SELECT TO authenticated USING (((school_id = public.current_user_school_id()) AND public.current_user_can_manage_access()));


--
-- Name: school_pto_types Allow users to read PTO types for their school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow users to read PTO types for their school" ON public.school_pto_types FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.user_id = auth.uid()) AND (p.school_id = school_pto_types.school_id)))));


--
-- Name: schools Authenticated users can read schools; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can read schools" ON public.schools FOR SELECT TO authenticated USING (true);


--
-- Name: profiles Only access managers may update profiles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Only access managers may update profiles" ON public.profiles FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.user_id = auth.uid()) AND (p.school_id = profiles.school_id) AND ((p.can_manage_access = true) OR (p.is_superadmin = true)))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.user_id = auth.uid()) AND (p.school_id = profiles.school_id) AND ((p.can_manage_access = true) OR (p.is_superadmin = true))))));


--
-- Name: pto_requests Only approvers can update PTO requests; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Only approvers can update PTO requests" ON public.pto_requests FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.user_id = auth.uid()) AND (p.school_id = pto_requests.school_id) AND (p.can_approve_pto = true))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.user_id = auth.uid()) AND (p.school_id = pto_requests.school_id) AND (p.can_approve_pto = true)))));


--
-- Name: guardians Profiles with can_manage_guardians can delete guardians; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Profiles with can_manage_guardians can delete guardians" ON public.guardians FOR DELETE TO authenticated USING (((auth.uid() IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.user_id = auth.uid()) AND (p.school_id = guardians.school_id) AND (p.can_manage_guardians = true))))));


--
-- Name: guardians Profiles with can_manage_guardians can update guardians; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Profiles with can_manage_guardians can update guardians" ON public.guardians FOR UPDATE TO authenticated USING (((auth.uid() IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.user_id = auth.uid()) AND (p.school_id = guardians.school_id) AND (p.can_manage_guardians = true)))))) WITH CHECK (((school_id IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.user_id = auth.uid()) AND (p.school_id = guardians.school_id) AND (p.can_manage_guardians = true))))));


--
-- Name: guardians Staff can read guardians in their school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Staff can read guardians in their school" ON public.guardians FOR SELECT TO authenticated USING ((school_id IN ( SELECT profiles.school_id
   FROM public.profiles
  WHERE (profiles.user_id = auth.uid()))));


--
-- Name: pto_requests Staff can request cancellation of their own PTO; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Staff can request cancellation of their own PTO" ON public.pto_requests FOR UPDATE TO authenticated USING ((employee_id = ( SELECT profiles.employee_id
   FROM public.profiles
  WHERE (profiles.user_id = auth.uid())))) WITH CHECK (((employee_id = ( SELECT profiles.employee_id
   FROM public.profiles
  WHERE (profiles.user_id = auth.uid()))) AND (status = ANY (ARRAY['CANCEL_REQUESTED'::public.pto_status, 'RESCIND_REQUESTED'::public.pto_status, 'CANCELLED'::public.pto_status]))));


--
-- Name: substitute_assignments Sub assignments: delete own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Sub assignments: delete own school" ON public.substitute_assignments FOR DELETE USING ((school_id = ( SELECT profiles.school_id
   FROM public.profiles
  WHERE (profiles.user_id = auth.uid()))));


--
-- Name: substitute_assignments Sub assignments: insert own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Sub assignments: insert own school" ON public.substitute_assignments FOR INSERT WITH CHECK ((school_id = ( SELECT profiles.school_id
   FROM public.profiles
  WHERE (profiles.user_id = auth.uid()))));


--
-- Name: substitute_assignments Sub assignments: read own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Sub assignments: read own school" ON public.substitute_assignments FOR SELECT USING ((school_id = ( SELECT profiles.school_id
   FROM public.profiles
  WHERE (profiles.user_id = auth.uid()))));


--
-- Name: substitute_assignments Sub assignments: update own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Sub assignments: update own school" ON public.substitute_assignments FOR UPDATE USING ((school_id = ( SELECT profiles.school_id
   FROM public.profiles
  WHERE (profiles.user_id = auth.uid()))));


--
-- Name: substitutes Substitutes: delete for own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Substitutes: delete for own school" ON public.substitutes FOR DELETE USING ((school_id = ( SELECT profiles.school_id
   FROM public.profiles
  WHERE (profiles.user_id = auth.uid()))));


--
-- Name: substitutes Substitutes: insert for own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Substitutes: insert for own school" ON public.substitutes FOR INSERT WITH CHECK ((school_id = ( SELECT profiles.school_id
   FROM public.profiles
  WHERE (profiles.user_id = auth.uid()))));


--
-- Name: substitutes Substitutes: read by school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Substitutes: read by school" ON public.substitutes FOR SELECT USING ((school_id = ( SELECT profiles.school_id
   FROM public.profiles
  WHERE (profiles.user_id = auth.uid()))));


--
-- Name: substitutes Substitutes: update for own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Substitutes: update for own school" ON public.substitutes FOR UPDATE USING ((school_id = ( SELECT profiles.school_id
   FROM public.profiles
  WHERE (profiles.user_id = auth.uid()))));


--
-- Name: profiles Users can create their own profile; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can create their own profile" ON public.profiles FOR INSERT TO authenticated WITH CHECK ((auth.uid() = user_id));


--
-- Name: profiles Users can read their own profile; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can read their own profile" ON public.profiles FOR SELECT TO authenticated USING ((auth.uid() = user_id));


--
-- Name: bulk_upload_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.bulk_upload_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: bus_groups; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.bus_groups ENABLE ROW LEVEL SECURITY;

--
-- Name: bus_groups bus_groups_delete_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY bus_groups_delete_admin ON public.bus_groups FOR DELETE USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.user_id = auth.uid()) AND (p.status = 'active'::text) AND ((p.is_superadmin = true) OR ((p.role = 'admin'::text) AND (p.school_id = bus_groups.school_id)))))));


--
-- Name: bus_groups bus_groups_insert_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY bus_groups_insert_admin ON public.bus_groups FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.user_id = auth.uid()) AND (p.status = 'active'::text) AND ((p.is_superadmin = true) OR (p.role = 'admin'::text))))));


--
-- Name: bus_groups bus_groups_read_same_school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY bus_groups_read_same_school ON public.bus_groups FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.user_id = auth.uid()) AND (p.status = 'active'::text) AND ((p.is_superadmin = true) OR (p.school_id = bus_groups.school_id))))));


--
-- Name: bus_groups bus_groups_update_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY bus_groups_update_admin ON public.bus_groups FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.user_id = auth.uid()) AND (p.status = 'active'::text) AND ((p.is_superadmin = true) OR ((p.role = 'admin'::text) AND (p.school_id = bus_groups.school_id))))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.user_id = auth.uid()) AND (p.status = 'active'::text) AND ((p.is_superadmin = true) OR ((p.role = 'admin'::text) AND (p.school_id = bus_groups.school_id)))))));


--
-- Name: carline_calls; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.carline_calls ENABLE ROW LEVEL SECURITY;

--
-- Name: carline_calls carline_calls_delete_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY carline_calls_delete_admin ON public.carline_calls FOR DELETE USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.user_id = auth.uid()) AND (p.status = 'active'::text) AND ((p.is_superadmin = true) OR (p.role = 'admin'::text))))));


--
-- Name: carline_calls carline_calls_insert_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY carline_calls_insert_admin ON public.carline_calls FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.user_id = auth.uid()) AND (p.status = 'active'::text) AND ((p.is_superadmin = true) OR (p.role = 'admin'::text))))));


--
-- Name: carline_calls carline_calls_read_same_school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY carline_calls_read_same_school ON public.carline_calls FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.user_id = auth.uid()) AND (p.status = 'active'::text) AND ((p.is_superadmin = true) OR (p.school_id = carline_calls.school_id))))));


--
-- Name: carline_calls carline_calls_update_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY carline_calls_update_admin ON public.carline_calls FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.user_id = auth.uid()) AND (p.status = 'active'::text) AND ((p.is_superadmin = true) OR (p.role = 'admin'::text))))));


--
-- Name: carline_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.carline_events ENABLE ROW LEVEL SECURITY;

--
-- Name: carline_events carline_events_delete_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY carline_events_delete_admin ON public.carline_events FOR DELETE USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.user_id = auth.uid()) AND (p.status = 'active'::text) AND ((p.is_superadmin = true) OR (p.role = 'admin'::text))))));


--
-- Name: carline_events carline_events_insert_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY carline_events_insert_admin ON public.carline_events FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.user_id = auth.uid()) AND (p.status = 'active'::text) AND ((p.is_superadmin = true) OR (p.role = 'admin'::text))))));


--
-- Name: carline_events carline_events_read_same_school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY carline_events_read_same_school ON public.carline_events FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.user_id = auth.uid()) AND (p.status = 'active'::text) AND ((p.is_superadmin = true) OR (p.school_id = carline_events.school_id))))));


--
-- Name: carline_events carline_events_update_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY carline_events_update_admin ON public.carline_events FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.user_id = auth.uid()) AND (p.status = 'active'::text) AND ((p.is_superadmin = true) OR (p.role = 'admin'::text))))));


--
-- Name: carline_tags; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.carline_tags ENABLE ROW LEVEL SECURITY;

--
-- Name: employee_pto_policies; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.employee_pto_policies ENABLE ROW LEVEL SECURITY;

--
-- Name: pto_requests employee_self_create_pto; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY employee_self_create_pto ON public.pto_requests FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM (public.profiles p
     JOIN public.employees e ON ((e.user_id = p.user_id)))
  WHERE ((p.user_id = auth.uid()) AND (p.school_id = pto_requests.school_id) AND (e.id = pto_requests.employee_id) AND (p.status = 'active'::text)))));


--
-- Name: employees; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.employees ENABLE ROW LEVEL SECURITY;

--
-- Name: employees employees_delete_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY employees_delete_admin ON public.employees FOR DELETE USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.user_id = auth.uid()) AND (p.status = 'active'::text) AND ((p.is_superadmin = true) OR ((p.role = 'admin'::text) AND (p.school_id = employees.school_id)))))));


--
-- Name: employees employees_insert_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY employees_insert_admin ON public.employees FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.user_id = auth.uid()) AND (p.status = 'active'::text) AND ((p.is_superadmin = true) OR (p.role = 'admin'::text))))));


--
-- Name: employees employees_read_same_school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY employees_read_same_school ON public.employees FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.user_id = auth.uid()) AND (p.status = 'active'::text) AND ((p.is_superadmin = true) OR (p.school_id = employees.school_id))))));


--
-- Name: employees employees_sub_manager_read_school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY employees_sub_manager_read_school ON public.employees FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.user_id = auth.uid()) AND (p.status = 'active'::text) AND (p.school_id = employees.school_id) AND (p.can_manage_substitutes = true)))));


--
-- Name: employees employees_update_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY employees_update_admin ON public.employees FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.user_id = auth.uid()) AND (p.status = 'active'::text) AND ((p.is_superadmin = true) OR ((p.role = 'admin'::text) AND (p.school_id = employees.school_id))))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.user_id = auth.uid()) AND (p.status = 'active'::text) AND ((p.is_superadmin = true) OR ((p.role = 'admin'::text) AND (p.school_id = employees.school_id)))))));


--
-- Name: families; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.families ENABLE ROW LEVEL SECURITY;

--
-- Name: families families_delete_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY families_delete_admin ON public.families FOR DELETE USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.user_id = auth.uid()) AND (p.status = 'active'::text) AND ((p.is_superadmin = true) OR ((p.role = 'admin'::text) AND (p.school_id = families.school_id)))))));


--
-- Name: families families_insert_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY families_insert_admin ON public.families FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.user_id = auth.uid()) AND (p.status = 'active'::text) AND ((p.is_superadmin = true) OR (p.role = 'admin'::text))))));


--
-- Name: families families_read_same_school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY families_read_same_school ON public.families FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.user_id = auth.uid()) AND (p.status = 'active'::text) AND ((p.is_superadmin = true) OR (p.school_id = families.school_id))))));


--
-- Name: families families_update_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY families_update_admin ON public.families FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.user_id = auth.uid()) AND (p.status = 'active'::text) AND ((p.is_superadmin = true) OR ((p.role = 'admin'::text) AND (p.school_id = families.school_id))))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.user_id = auth.uid()) AND (p.status = 'active'::text) AND ((p.is_superadmin = true) OR ((p.role = 'admin'::text) AND (p.school_id = families.school_id)))))));


--
-- Name: guardians; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.guardians ENABLE ROW LEVEL SECURITY;

--
-- Name: profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: profiles profiles_read_self; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY profiles_read_self ON public.profiles FOR SELECT USING ((user_id = auth.uid()));


--
-- Name: profiles profiles_update_self; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY profiles_update_self ON public.profiles FOR UPDATE USING ((user_id = auth.uid())) WITH CHECK ((user_id = auth.uid()));


--
-- Name: pto_ledger pto_admin_insert_ledger; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pto_admin_insert_ledger ON public.pto_ledger FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.user_id = auth.uid()) AND (p.school_id = pto_ledger.school_id) AND (p.role = ANY (ARRAY['admin'::text, 'hr'::text])) AND (p.status = 'active'::text)))));


--
-- Name: pto_requests pto_admin_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pto_admin_update ON public.pto_requests FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.user_id = auth.uid()) AND (p.school_id = pto_requests.school_id) AND (p.role = ANY (ARRAY['admin'::text, 'hr'::text]))))));


--
-- Name: pto_balances pto_admin_write_balances; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pto_admin_write_balances ON public.pto_balances USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.user_id = auth.uid()) AND (p.school_id = pto_balances.school_id) AND (p.role = ANY (ARRAY['admin'::text, 'hr'::text]))))));


--
-- Name: pto_balances; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pto_balances ENABLE ROW LEVEL SECURITY;

--
-- Name: pto_balances pto_balances_insert_from_ledger; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pto_balances_insert_from_ledger ON public.pto_balances FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM public.employees e
  WHERE ((e.id = pto_balances.employee_id) AND (e.school_id = pto_balances.school_id)))));


--
-- Name: pto_balances pto_balances_select_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pto_balances_select_admin ON public.pto_balances FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.user_id = auth.uid()) AND (p.school_id = pto_balances.school_id) AND (p.can_review_pto = true)))));


--
-- Name: pto_balances pto_balances_update_from_ledger; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pto_balances_update_from_ledger ON public.pto_balances FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM public.employees e
  WHERE ((e.id = pto_balances.employee_id) AND (e.school_id = pto_balances.school_id)))));


--
-- Name: pto_ledger; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pto_ledger ENABLE ROW LEVEL SECURITY;

--
-- Name: pto_ledger pto_ledger_insert_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pto_ledger_insert_admin ON public.pto_ledger FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.user_id = auth.uid()) AND (p.status = 'active'::text) AND ((p.is_superadmin = true) OR ((p.school_id = pto_ledger.school_id) AND (p.role = ANY (ARRAY['admin'::text, 'hr'::text]))))))));


--
-- Name: pto_ledger pto_ledger_read_same_school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pto_ledger_read_same_school ON public.pto_ledger FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.user_id = auth.uid()) AND (p.status = 'active'::text) AND ((p.is_superadmin = true) OR (p.school_id = pto_ledger.school_id))))));


--
-- Name: pto_requests; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pto_requests ENABLE ROW LEVEL SECURITY;

--
-- Name: pto_requests pto_requests_admin_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pto_requests_admin_read ON public.pto_requests FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.user_id = auth.uid()) AND (p.status = 'active'::text) AND (p.school_id = pto_requests.school_id) AND ((p.role = 'admin'::text) OR (p.is_superadmin = true))))));


--
-- Name: pto_requests pto_requests_admin_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pto_requests_admin_update ON public.pto_requests FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.user_id = auth.uid()) AND (p.status = 'active'::text) AND (p.school_id = pto_requests.school_id) AND ((p.role = 'admin'::text) OR (p.is_superadmin = true))))));


--
-- Name: pto_requests pto_requests_insert_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pto_requests_insert_own ON public.pto_requests FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.user_id = auth.uid()) AND (p.status = 'active'::text) AND (p.employee_id = pto_requests.employee_id) AND (p.school_id = pto_requests.school_id)))));


--
-- Name: pto_requests pto_requests_staff_cancel; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pto_requests_staff_cancel ON public.pto_requests FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.user_id = auth.uid()) AND (p.employee_id = pto_requests.employee_id) AND (p.school_id = pto_requests.school_id) AND (p.status = 'active'::text))))) WITH CHECK ((status = 'CANCELLED'::public.pto_status));


--
-- Name: pto_requests pto_requests_staff_read_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pto_requests_staff_read_own ON public.pto_requests FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.user_id = auth.uid()) AND (p.status = 'active'::text) AND (p.employee_id = pto_requests.employee_id)))));


--
-- Name: pto_requests pto_requests_sub_manager_read_coverage; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pto_requests_sub_manager_read_coverage ON public.pto_requests FOR SELECT TO authenticated USING (((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.user_id = auth.uid()) AND (p.status = 'active'::text) AND (p.school_id = pto_requests.school_id) AND (p.can_manage_substitutes = true)))) AND (needs_sub_coverage = true)));


--
-- Name: carline_tags same_school_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY same_school_read ON public.carline_tags FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.user_id = auth.uid()) AND (p.status = 'active'::text) AND ((p.is_superadmin = true) OR (p.school_id = carline_tags.school_id))))));


--
-- Name: guardians same_school_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY same_school_read ON public.guardians FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.user_id = auth.uid()) AND (p.status = 'active'::text) AND ((p.is_superadmin = true) OR (p.school_id = guardians.school_id))))));


--
-- Name: pto_balances same_school_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY same_school_read ON public.pto_balances FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.user_id = auth.uid()) AND (p.status = 'active'::text) AND ((p.is_superadmin = true) OR (p.school_id = pto_balances.school_id))))));


--
-- Name: pto_ledger same_school_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY same_school_read ON public.pto_ledger FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.user_id = auth.uid()) AND (p.status = 'active'::text) AND ((p.is_superadmin = true) OR (p.school_id = pto_ledger.school_id))))));


--
-- Name: school_domains same_school_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY same_school_read ON public.school_domains FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.user_id = auth.uid()) AND (p.status = 'active'::text) AND ((p.is_superadmin = true) OR (p.school_id = school_domains.school_id))))));


--
-- Name: school_domains; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.school_domains ENABLE ROW LEVEL SECURITY;

--
-- Name: school_modules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.school_modules ENABLE ROW LEVEL SECURITY;

--
-- Name: school_pto_types; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.school_pto_types ENABLE ROW LEVEL SECURITY;

--
-- Name: school_settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.school_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: school_student_sequences; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.school_student_sequences ENABLE ROW LEVEL SECURITY;

--
-- Name: schools; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.schools ENABLE ROW LEVEL SECURITY;

--
-- Name: schools schools_read_my_school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY schools_read_my_school ON public.schools FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.user_id = auth.uid()) AND (p.status = 'active'::text) AND ((p.is_superadmin = true) OR (p.school_id = schools.id))))));


--
-- Name: school_settings staff can read school settings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "staff can read school settings" ON public.school_settings FOR SELECT USING (true);


--
-- Name: students; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.students ENABLE ROW LEVEL SECURITY;

--
-- Name: students students_delete_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY students_delete_admin ON public.students FOR DELETE USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.user_id = auth.uid()) AND (p.status = 'active'::text) AND ((p.is_superadmin = true) OR ((p.role = 'admin'::text) AND (p.school_id = students.school_id)))))));


--
-- Name: students students_insert_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY students_insert_admin ON public.students FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.user_id = auth.uid()) AND (p.status = 'active'::text) AND ((p.is_superadmin = true) OR (p.role = 'admin'::text))))));


--
-- Name: students students_read_same_school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY students_read_same_school ON public.students FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.user_id = auth.uid()) AND (p.status = 'active'::text) AND ((p.is_superadmin = true) OR (p.school_id = students.school_id))))));


--
-- Name: students students_update_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY students_update_admin ON public.students FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.user_id = auth.uid()) AND (p.status = 'active'::text) AND ((p.is_superadmin = true) OR ((p.role = 'admin'::text) AND (p.school_id = students.school_id))))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.user_id = auth.uid()) AND (p.status = 'active'::text) AND ((p.is_superadmin = true) OR ((p.role = 'admin'::text) AND (p.school_id = students.school_id)))))));


--
-- Name: substitute_assignments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.substitute_assignments ENABLE ROW LEVEL SECURITY;

--
-- Name: substitutes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.substitutes ENABLE ROW LEVEL SECURITY;

--
-- PostgreSQL database dump complete
--

\unrestrict OjdQirAiMrOguwRQuNVQO2y45hoAqHRTkUVfp5g1d7wP7RYTwZF6sUDYTWXPHOu

