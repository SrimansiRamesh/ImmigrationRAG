// NOTE: @supabase/auth-helpers-nextjs is now an alias for @supabase/ssr and no
// longer exports createClientComponentClient. createBrowserClient is the modern
// equivalent for a client-component Supabase client; it reads the same public
// env vars (NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY).
import { createBrowserClient } from '@supabase/auth-helpers-nextjs'

export const supabase = createBrowserClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
)
