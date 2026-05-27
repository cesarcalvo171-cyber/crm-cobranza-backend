require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function checkColumns() {
  const { data, error } = await supabase
    .from('customers')
    .select('*')
    .limit(1);

  if (error) {
    console.error('Error fetching customers:', error);
  } else {
    console.log('Customer columns:', data.length > 0 ? Object.keys(data[0]) : 'No records found to determine columns');
  }
}

checkColumns();
