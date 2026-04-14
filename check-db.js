const { Client } = require('pg');
const client = new Client({ 
  connectionString: 'postgresql://polymarket:polymarket@localhost:5433/polymarket' 
});

client.connect()
  .then(() => client.query('SELECT market_id, price, size_usd, time FROM price_history ORDER BY time DESC LIMIT 5'))
  .then(res => {
    console.log('\n📊 Recent trades in database:\n');
    res.rows.forEach((r, i) => {
      console.log(`${i+1}. Market: ${r.market_id}`);
      console.log(`   Price: ${r.price}`);
      console.log(`   Size: $${r.size_usd.toLocaleString()} USDC`);
      console.log(`   Time: ${r.time}\n`);
    });
    client.end();
  })
  .catch(e => {
    console.log('Error:', e.message);
    process.exit(1);
  });
