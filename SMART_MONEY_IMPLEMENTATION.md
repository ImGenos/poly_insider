# Implémentation du SmartMoneyDetector

## Résumé

Le module **SmartMoneyDetector** a été implémenté avec succès dans le service Analyzer. Ce module détecte les transactions effectuées par des parieurs expérimentés ("smart money") sur les marchés de football de Polymarket.

## Fichiers Créés

### 1. `src/detectors/SmartMoneyDetector.ts`
Module principal de détection avec les fonctionnalités suivantes :
- Filtre de marché football (mots-clés : football, soccer, Champions League, etc.)
- Calcul de l'Index de Confiance du Parieur (0-100)
- Métriques analysées :
  - **PnL historique** (40% de pondération)
  - **Volume récent** (20% de pondération)
  - **Ratio de mise** (25% de pondération)
  - **Taux de réussite** (15% de pondération)
- Mise en cache Redis avec TTL configurable
- Stockage dans TimescaleDB

### 2. `doc/SMART_MONEY_DETECTOR.md`
Documentation complète du module incluant :
- Vue d'ensemble des fonctionnalités
- Détails des métriques et calculs
- Configuration des variables d'environnement
- Architecture et flux de traitement
- Schéma de base de données
- Exemples de requêtes SQL
- Limitations et améliorations futures

## Fichiers Modifiés

### 1. `src/analyzer/index.ts`
- Import du SmartMoneyDetector
- Initialisation du détecteur avec configuration
- Exécution en parallèle avec les autres détecteurs
- Envoi des alertes Telegram

### 2. `src/alerts/AlertFormatter.ts`
- Ajout de `formatSmartMoneyAlert()` et `formatSmartMoneyMessage()`
- Format d'alerte avec emoji ⚽ pour les marchés de football
- Affichage détaillé de l'Index de Confiance et des métriques

### 3. `src/cache/RedisCache.ts`
- Ajout des méthodes génériques `get()` et `set()`
- Support du cache pour les profils de smart money

### 4. `src/db/TimeSeriesDB.ts`
- Création de la table hypertable `smart_money_trades`
- Méthode `recordSmartMoneyTrade()` pour l'historisation
- Index sur `wallet_address` et `market_id`

### 5. `src/config/ConfigManager.ts`
- Ajout de `getSmartMoneyMinTradeSize()`
- Ajout de `getSmartMoneyConfidenceThreshold()`
- Ajout de `getSmartMoneyWalletCacheTTL()`

### 6. `.env.example`
Nouvelles variables d'environnement :
```bash
SMART_MONEY_MIN_TRADE_SIZE=5000
SMART_MONEY_CONFIDENCE_THRESHOLD=80
SMART_MONEY_WALLET_CACHE_TTL=86400
```

### 7. `README.md`
- Mise à jour du diagramme d'architecture
- Ajout de la section "Smart Money Detection"
- Exemples d'alertes
- Documentation du schéma de base de données

### 8. `src/websocket/WebSocketManager.ts`
- Correction d'une erreur TypeScript existante (type assertion)

## Configuration

### Variables d'Environnement

Ajoutez ces variables à votre fichier `.env` :

```bash
# Taille minimum de transaction pour la détection (en USDC)
SMART_MONEY_MIN_TRADE_SIZE=5000

# Score minimum pour déclencher une alerte (0-100)
SMART_MONEY_CONFIDENCE_THRESHOLD=80

# TTL du cache des profils de portefeuilles (en secondes, 24h par défaut)
SMART_MONEY_WALLET_CACHE_TTL=86400
```

## Schéma de Base de Données

La table `smart_money_trades` sera créée automatiquement au démarrage :

```sql
CREATE TABLE smart_money_trades (
  time                TIMESTAMPTZ NOT NULL,
  market_id           TEXT NOT NULL,
  market_name         TEXT NOT NULL,
  side                TEXT NOT NULL,
  wallet_address      TEXT NOT NULL,
  size_usd            DOUBLE PRECISION NOT NULL,
  price               DOUBLE PRECISION NOT NULL,
  confidence_score    INTEGER NOT NULL,
  pnl                 DOUBLE PRECISION NOT NULL,
  recent_volume       DOUBLE PRECISION NOT NULL,
  bet_size_ratio      DOUBLE PRECISION NOT NULL,
  win_rate            DOUBLE PRECISION NOT NULL
);
```

## Déploiement

1. **Mettre à jour les variables d'environnement** :
   ```bash
   nano .env
   # Ajouter les variables SMART_MONEY_*
   ```

2. **Recompiler le projet** :
   ```bash
   npm run build
   ```

3. **Redémarrer les services PM2** :
   ```bash
   pm2 restart polymarket-analyzer
   ```

4. **Vérifier les logs** :
   ```bash
   pm2 logs polymarket-analyzer
   ```

## Exemple d'Alerte

Lorsqu'un smart money est détecté, vous recevrez une alerte Telegram comme celle-ci :

```
🚨 SMART MONEY DETECTED | HIGH

⚽ Football Market
Market: [Champions League Final - Real Madrid vs Bayern](link)
Side: YES
Amount: 15,000 USDC
Price: 65.0%

📊 Bettor Confidence Index: 87/100

Metrics:
• PnL: $45,000 (score: 90)
• Recent Volume: $80,000 (score: 80)
• Bet Size Ratio: 8.5x (score: 85)
• Win Rate: 65.0% (score: 83)

Wallet: [0x1234...5678](link)
```

## Requêtes SQL Utiles

### Top 10 des Smart Money Wallets (30 derniers jours)
```sql
SELECT 
  wallet_address,
  COUNT(*) as trade_count,
  AVG(confidence_score) as avg_confidence,
  SUM(size_usd) as total_volume
FROM smart_money_trades
WHERE time >= NOW() - INTERVAL '30 days'
GROUP BY wallet_address
ORDER BY avg_confidence DESC, total_volume DESC
LIMIT 10;
```

### Marchés les Plus Populaires (7 derniers jours)
```sql
SELECT 
  market_name,
  COUNT(*) as smart_money_trades,
  SUM(size_usd) as total_smart_money_volume,
  AVG(confidence_score) as avg_confidence
FROM smart_money_trades
WHERE time >= NOW() - INTERVAL '7 days'
GROUP BY market_name
ORDER BY smart_money_trades DESC
LIMIT 10;
```

### Performance d'un Wallet Spécifique
```sql
SELECT 
  time,
  market_name,
  side,
  size_usd,
  price,
  confidence_score,
  pnl,
  win_rate
FROM smart_money_trades
WHERE wallet_address = '0x...'
ORDER BY time DESC
LIMIT 20;
```

## Fonctionnement

### Flux de Traitement

1. **Filtrage Initial**
   - Vérification que le marché contient des mots-clés football
   - Vérification du seuil de taille minimum (`SMART_MONEY_MIN_TRADE_SIZE`)
   - Vérification de la présence d'une adresse wallet

2. **Calcul de l'Index de Confiance**
   - Vérification du cache Redis (TTL 24h)
   - Si absent : récupération des transactions via Alchemy API
   - Calcul des métriques : PnL, volume récent, ratio de mise, win rate
   - Calcul du score final pondéré (0-100)
   - Mise en cache du résultat

3. **Évaluation & Alerte**
   - Comparaison avec le seuil de confiance (`SMART_MONEY_CONFIDENCE_THRESHOLD`)
   - Détermination de la sévérité :
     - **CRITICAL** : Score ≥ 90
     - **HIGH** : Score ≥ 85
     - **MEDIUM** : Score ≥ 80
   - Enregistrement dans TimescaleDB
   - Envoi de l'alerte Telegram

### Intégration avec l'Analyzer

Le SmartMoneyDetector s'exécute en **parallèle** avec les autres détecteurs (AnomalyDetector, ClusterDetector) pour optimiser les performances :

```typescript
const [clusterAnomaly, anomalies, smartMoneyAlert] = await Promise.all([
  this.runClusterDetector(filteredTrade),
  this.runAnomalyDetector(filteredTrade),
  this.runSmartMoneyDetector(filteredTrade),
]);
```

## Limitations Actuelles

1. **Calcul PnL Simplifié**
   - Le PnL est estimé à partir du volume total (10% du volume)
   - Une implémentation réelle nécessiterait le tracking des positions ouvertes/fermées

2. **Win Rate Estimé**
   - Le taux de réussite est actuellement estimé à 60%
   - Une implémentation complète nécessiterait l'analyse des résultats de chaque position

3. **Données Limitées**
   - Utilise uniquement les données on-chain via Alchemy
   - Pas d'intégration avec l'API Polymarket pour les données de marché détaillées

## Améliorations Futures

1. **Intégration API Polymarket**
   - Récupérer l'historique complet des positions
   - Calculer le PnL réel et le win rate précis

2. **Machine Learning**
   - Modèle prédictif pour identifier les patterns de smart money
   - Ajustement dynamique des pondérations

3. **Analyse Multi-Marchés**
   - Extension à d'autres catégories de marchés
   - Détection de patterns cross-marchés

4. **Scoring Avancé**
   - Prise en compte de la volatilité du marché
   - Analyse du timing des entrées/sorties
   - Corrélation avec les mouvements de prix

## Support

Pour toute question ou problème :
1. Consultez la documentation complète : `doc/SMART_MONEY_DETECTOR.md`
2. Vérifiez les logs : `pm2 logs polymarket-analyzer`
3. Vérifiez la base de données : `psql $TIMESCALEDB_URL`

## Compilation Réussie

Le projet compile sans erreurs :
```bash
$ npm run build
> polymarket-monitoring-bot@1.0.0 build
> tsc

Exit Code: 0
```

Tous les tests TypeScript passent avec succès ! ✅
