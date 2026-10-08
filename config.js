// Public client config. Westley's Book shares the household-meals Supabase project (all tables are wb_*).
// The publishable key is safe to ship in a browser: all data access is enforced by Row Level Security
// (only the two parents in wb_parents can see anything). Never put a service_role / secret key here.
export const SUPABASE_URL = 'https://voydoxmxdnjnewxlwzse.supabase.co';
export const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_FO-tgfKuBTb19W8GaX1qZw_dtZRRdqY';
// Web Push (VAPID) public key for the wb-push Edge Function. Public by design; the private key stays in Vault.
export const VAPID_PUBLIC_KEY = 'BP0moZKgNGXdvwvzk0Z10J6StDKEyO-pq_PYZ7cFYoNz8FRpbkefDRBqGxi7JaHq2XcIL4fhX895p1e6RZ_2c6U';
export const PUSH_FUNCTION = 'wb-push';
export const PHOTO_BUCKET = 'wb-photos';
