
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = 'https://xrhwjjkxlshfarlxuxsa.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhyaHdqamt4bHNoZmFybHh1eHNhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3MzY0OTcsImV4cCI6MjA5MTMxMjQ5N30.Gf4oUa33DzIkc3fHwbyq-xc6Ptqq1jMFBzPCQM8dT-s';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true
  }
});
