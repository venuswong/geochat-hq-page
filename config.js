// Public settings for the HQ page. Both values are meant to be public: the
// anon key only lets a browser talk to the Data API, where row-level security
// decides what each login may see or do. No secret ever goes in this file.
window.HQ_CONFIG = {
  supabaseUrl: "https://lfmakstmokdpnnbmqdop.supabase.co",
  anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxmbWFrc3Rtb2tkcG5uYm1xZG9wIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTM3MTk2MzEsImV4cCI6MjEwOTI5NTYzMX0.N5P8tqiWFQUjrzfsLROLhny2ORzz3tHSCCQkHbGHWUs",
};
