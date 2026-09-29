// Sync is off until both of these are filled in. See "Syncing with Supabase"
// in README.md.
//
// Both values are meant to be public: the publishable key only lets a
// signed-in person reach their own rows, which the row level security policies
// in supabase/schema.sql enforce. Never put the service_role or secret key here.
window.SR_CONFIG = {
  supabaseUrl: 'https://eprnqwvakpqhazdvrwlh.supabase.co',  // project "speed reader"
  supabaseAnonKey: 'sb_publishable_YgC7SSmMbIERQZsDymD_zQ_XYu5VDLc',
};
