# Polymarket Monitoring - Quick Reference

## 🚀 Essential Commands

```bash
# Start everything (first time or daily)
start.bat

# Restart after code changes
restart.bat

# Stop everything
stop.bat

# Check status
status.bat

# View live logs
npm run logs
```

## 📊 Monitoring

```bash
# Check if services are running
npx pm2 status

# View specific service logs
npm run logs:ingestor
npm run logs:analyzer

# Check Docker containers
docker ps

# Check Redis stream depth
docker exec polynsider-redis-1 redis-cli XLEN trades:stream

# Check database detections
docker exec polynsider-timescaledb-1 psql -U polymarket -d polymarket -c "SELECT COUNT(*) FROM cluster_trades;"
```

## 🔧 Troubleshooting

### Services won't start?
1. Is Docker running? Check Docker Desktop
2. Run: `docker-compose down` then `start.bat`

### No trades detected?
1. Check logs: `npm run logs:ingestor`
2. Look for "WebSocket connected" message
3. Check stream: `docker exec polynsider-redis-1 redis-cli XLEN trades:stream`

### Telegram not working?
1. Check `.env` file has correct `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`
2. Look in `failed-alerts.log` for errors

## 📁 Important Files

- `.env` - Configuration (API keys, tokens)
- `logs/` - All log files
- `failed-alerts.log` - Failed Telegram messages
- `ecosystem.config.js` - PM2 configuration

## 🎯 What Each Service Does

**Ingestor**: Connects to Polymarket WebSocket, receives trades, pushes to Redis
**Analyzer**: Reads from Redis, detects patterns, sends Telegram alerts

## 💡 Pro Tips

- Use `restart.bat` instead of `start.bat` when you only changed code
- Check `status.bat` regularly to ensure everything is running
- Logs are your friend - always check them first when troubleshooting
- The system auto-reconnects if WebSocket drops
- Detections are stored in TimescaleDB even if Telegram fails
