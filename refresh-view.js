const { Client } = require('pg');
const client = new Client({ 
  connectionString: 'postgresql://polymarket:polymarket@localhost:5433/polymarket' 
});

console.log('🔄 Refreshing materialized view...\n');

client.connect()
  .then(() => {
    return client.query("CALL refresh_continuous_aggregate('market_volatility_1h', NULL, NULL)");
  })
  .then(() => {
    console.log('✅ View refreshed!\n');
    return client.query('SELECT * FROM market_volatility_1h ORDER BY bucket DESC LIMIT 5');
  })
  .then(res => {
    console.log('📊 Latest volatility data:\n');
    res.rows.forEach((r, i) => {
      console.log(`${i+1}. Market: ${r.market_id}`);
      console.log(`   Bucket: ${r.bucket}`);
      console.log(`   Avg Trade Size: $${parseFloat(r.avg_trade_size).toFixed(2)}`);
      console.log(`   Stddev Trade Size: $${parseFloat(r.stddev_trade_size || 0).toFixed(2)}`);
      console.log(`   Sample Count: ${r.trade_count}`);
      console.log('');
    });
    client.end();
  })
  .catch(e => {
    console.error('❌ Error:', e.message);
    client.end();
    process.exit(1);
  });
