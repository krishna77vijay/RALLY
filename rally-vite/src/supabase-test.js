
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
)

async function testConnection() {
  const { data, error } = await supabase
    .from('games')
    .select('id')
    .limit(1)

  if (error) {
    console.error('RALLY database connection failed:', error.message)
    return
  }

  console.log('RALLY database connection successful!')
  console.log('Games returned:', data)
}

testConnection()
