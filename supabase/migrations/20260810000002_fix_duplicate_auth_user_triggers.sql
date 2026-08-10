-- Three separate AFTER INSERT triggers existed on auth.users, all trying to
-- create a public.profiles row on signup:
--   - create_profile_for_new_user  -> create_profile_for_new_user()
--   - on_auth_user_created         -> create_profile_for_new_user()  (duplicate registration)
--   - trg_create_profile_on_auth   -> handle_new_auth_user()          (competing implementation)
--
-- Because profiles.email is unique, the second trigger to run always hits a
-- conflict on the row the first trigger just claimed/inserted, aborting the
-- transaction with "Database error saving new user" for every new signup.
--
-- Keep create_profile_for_new_user() as the single source of truth (it
-- claims pre-seeded pending profiles by email, matches school by domain,
-- and defaults new profiles to status='pending'/can_login=false).
-- handle_new_auth_user() is dropped entirely: besides being redundant, it
-- unconditionally set status='active', can_login=true for any new signup
-- from any domain.

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
DROP TRIGGER IF EXISTS trg_create_profile_on_auth ON auth.users;
DROP FUNCTION IF EXISTS public.handle_new_auth_user();
