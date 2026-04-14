# SmartMoneyDetector - Documentation

## Vue d'ensemble

Le **SmartMoneyDetector** est un module d'analyse avancé qui identifie les transactions effectuées par des "smart money" (parieurs expérimentés et performants) sur les marchés de football de Polymarket.

## Fonctionnalités

### 1. Filtre de Marché Football

Le détecteur ne traite que les marchés liés au football, identifiés par des mots-clés dans le nom du marché ou la catégorie :

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

### 2. Index de Confiance du Parieur (Bettor Confidence Index)

Pour chaque transaction dépassant le seuil minimum (`SMART_MONEY_MIN_TRADE_SIZE`), le module calcule un score de confiance sur 100 basé sur les métriques on-chain suivantes :

#### Métriques Analysées

1. **Historique PnL (Profit & Loss)** - Pondération : 40%
   - Analyse le profit/perte historique du portefeuille sur Polymarket
   - Score : 0-100 (0 = PnL négatif, 100 = PnL > $50k)

2. **Volume Récent** - Pondération : 20%
   - Volume de trading des 30 derniers jours
   - Score : 0-100 (0 = < $1k, 100 = > $100k)

3. **Ratio de Mise (Bet Size Ratio)** - Pondération : 25%
   - Ratio entre la mise actuelle et la mise moyenne historique
   - Score : 0-100 (0 = < 0.5x, 100 = > 10x)
   - Une mise 10x supérieure à la moyenne indique une conviction très forte

4. **Taux de Réussite (Win Rate)** - Pondération : 15%
   - Ratio de positions clôturées en profit vs en perte
   - Score : 0-100 (0 = < 40%, 100 = > 70%)

#### Formule du Score Final

```
Score = (PnL Score × 0.40) + (Volume Score × 0.20) + (Bet Size Score × 0.25) + (Win Rate Score × 0.15)
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
- Le marché est lié au football
- La transaction dépasse `SMART_MONEY_MIN_TRADE_SIZE`
- L'Index de Confiance dépasse `SMART_MONEY_CONFIDENCE_THRESHOLD` (défaut : 80/100)

#### Format de l'Alerte

```
🚨 SMART MONEY DETECTED | HIGH

⚽ Football Market
Market: [Nom du marché](lien)
Side: YES
Amount: 15,000 USDC
Price: 65.0%

📊 Bettor Confidence Index: 87/100

Metrics:
• PnL: $45,000 (score: 90)
• Recent Volume: $80,000 (score: 80)
• Bet Size Ratio: 8.5x (score: 85)
• Win Rate: 65.0% (score: 83)

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
   - Vérification du marché football
   - Vérification du seuil de taille minimum
   - Vérification de la présence d'une adresse wallet

2. **Calcul de l'Index de Confiance**
   - Vérification du cache Redis
   - Si absent : récupération des métriques via Alchemy
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

1. **Calcul PnL Simplifié**
   - Le PnL est estimé à partir du volume total
   - Une implémentation réelle nécessiterait le tracking des positions ouvertes/fermées

2. **Win Rate Estimé**
   - Le taux de réussite est actuellement estimé à 60%
   - Une implémentation complète nécessiterait l'analyse des résultats de chaque position

3. **Données Limitées**
   - Utilise uniquement les données on-chain via Alchemy
   - Pas d'intégration avec l'API Polymarket pour les données de marché détaillées

### Améliorations Futures

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
