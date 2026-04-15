# SmartMoneyDetector - Documentation

## Vue d'ensemble

Le **SmartMoneyDetector** est un module d'analyse avancé qui identifie les transactions effectuées par des "smart money" (parieurs expérimentés et performants) sur les marchés de **football et de tennis** de Polymarket.

## Fonctionnalités

### 1. Filtre de Marché (Football & Tennis)

Le détecteur ne traite que les marchés liés au football ou au tennis, identifiés par des mots-clés dans le nom du marché ou la catégorie :

**Football / Soccer**
- football
- soccer
- champions league
- premier league
- la liga
- serie a
- bundesliga
- ligue 1
- uefa
- fifa
- world cup
- euro
- copa

**Tennis**
- tennis
- atp
- wta
- grand slam
- wimbledon
- roland garros
- us open
- australian open
- french open
- davis cup

La méthode `isSupportedMarket()` vérifie si le nom du marché ou sa catégorie contient l'un de ces mots-clés (insensible à la casse).

### 2. Index de Confiance du Parieur (Bettor Confidence Index)

Pour chaque transaction dépassant le seuil minimum (`SMART_MONEY_MIN_TRADE_SIZE`), le module calcule un score de confiance sur 100 basé sur les métriques on-chain suivantes :

#### Métriques Analysées

1. **Volume Récent** - Pondération : 35%
   - Volume de trading des 30 derniers jours
   - Score : 0-100 (0 = < $1k, 100 = > $100k)

2. **Ratio de Mise (Bet Size Ratio)** - Pondération : 35%
   - Ratio entre la mise actuelle et la mise moyenne historique
   - Score : 0-100 (0 = < 0.5x, 100 = > 10x)
   - Une mise 10x supérieure à la moyenne indique une conviction très forte

3. **Consistance d'Activité** - Pondération : 30%
   - Coefficient de variation (CV = écart-type / moyenne) des tailles de mise
   - Un CV faible = mises régulières = parieur discipliné
   - Score : 0-100 (0 = très irrégulier, 100 = parfaitement uniforme)

#### Formule du Score Final

```
Score = (Volume Score × 0.35) + (Bet Size Score × 0.35) + (Activity Consistency Score × 0.30)
```

### 3. Mise en Cache & Stockage

#### Cache Redis
- Les profils des portefeuilles sont mis en cache dans Redis
- TTL configurable via `SMART_MONEY_WALLET_CACHE_TTL` (défaut : 24h)
- Évite de spammer l'API Alchemy lors de transactions multiples par la même "baleine"

#### Stockage TimescaleDB
- Table hypertable `smart_money_trades` pour historiser les détections
- Stocke toutes les métriques du Bettor Confidence Index
- Permet l'analyse historique et le tracking des performances

### 4. Alertes Telegram

Une alerte Telegram est générée si :
- Le marché est lié au football **ou au tennis**
- La transaction dépasse `SMART_MONEY_MIN_TRADE_SIZE`
- L'Index de Confiance dépasse `SMART_MONEY_CONFIDENCE_THRESHOLD` (défaut : 80/100)

#### Format de l'Alerte

```
🚨 SMART MONEY DETECTED | HIGH

⚽ Football Market   (ou 🎾 Tennis Market)
Market: [Nom du marché](lien)
Side: YES
Amount: 15,000 USDC
Price: 65.0%

📊 Bettor Confidence Index: 87/100

Metrics:
• Recent Volume: $80,000 (score: 80)
• Bet Size Ratio: 8.5x (score: 85)
• Activity Consistency: 0.85 (score: 90)

Wallet: [0x1234...5678](lien)
```

#### Niveaux de Sévérité

- **CRITICAL** : Score ≥ 90
- **HIGH** : Score ≥ 85
- **MEDIUM** : Score ≥ 80

## Configuration

### Variables d'Environnement

```bash
# Taille minimum de transaction pour la détection (en USDC)
SMART_MONEY_MIN_TRADE_SIZE=5000

# Score minimum pour déclencher une alerte (0-100)
SMART_MONEY_CONFIDENCE_THRESHOLD=80

# TTL du cache des profils de portefeuilles (en secondes)
SMART_MONEY_WALLET_CACHE_TTL=86400
```

## Architecture

### Flux de Traitement

1. **Filtrage Initial**
   - Vérification du marché football ou tennis (`isSupportedMarket`)
   - Vérification du seuil de taille minimum
   - Vérification de la présence d'une adresse wallet

2. **Calcul de l'Index de Confiance**
   - Vérification du cache Redis
   - Si absent : récupération des métriques via Alchemy (transfers USDC vers Polymarket CTF Exchange)
   - Calcul des scores individuels
   - Calcul du score final pondéré
   - Mise en cache du résultat

3. **Évaluation & Alerte**
   - Comparaison avec le seuil de confiance
   - Détermination de la sévérité
   - Enregistrement dans TimescaleDB
   - Envoi de l'alerte Telegram

### Intégration avec l'Analyzer

Le SmartMoneyDetector s'exécute en parallèle avec les autres détecteurs (AnomalyDetector, ClusterDetector) pour optimiser les performances.

## Limitations & Améliorations Futures

### Limitations Actuelles

1. **Calcul PnL Non Disponible**
   - Le PnL ne peut pas être dérivé des seuls transfers USDC on-chain sans tracker les résolutions de marchés
   - Stocké à 0 en base comme placeholder neutre

2. **Win Rate Estimé**
   - Le taux de réussite est réutilisé pour stocker la consistance d'activité (même plage 0–1)
   - Une implémentation complète nécessiterait l'analyse des résultats de chaque position

3. **Données Limitées**
   - Utilise uniquement les données on-chain via Alchemy
   - Minimum 5 transfers requis pour calculer un score (wallets trop récents ignorés)

### Améliorations Futures

1. **Intégration API Polymarket**
   - Récupérer l'historique complet des positions
   - Calculer le PnL réel et le win rate précis

2. **Extension à d'autres sports**
   - Basketball (NBA, Euroleague)
   - Baseball, cricket, etc.

3. **Machine Learning**
   - Modèle prédictif pour identifier les patterns de smart money
   - Ajustement dynamique des pondérations

4. **Scoring Avancé**
   - Prise en compte de la volatilité du marché
   - Analyse du timing des entrées/sorties
   - Corrélation avec les mouvements de prix

## Schéma de Base de Données

### Table `smart_money_trades`

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

-- Hypertable TimescaleDB
SELECT create_hypertable('smart_money_trades', 'time', if_not_exists => TRUE);

-- Index pour les requêtes par wallet
CREATE INDEX idx_smart_money_wallet ON smart_money_trades(wallet_address, time DESC);

-- Index pour les requêtes par marché
CREATE INDEX idx_smart_money_market ON smart_money_trades(market_id, time DESC);
```

## Exemples de Requêtes

### Top 10 des Smart Money Wallets

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

### Marchés les Plus Populaires

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
