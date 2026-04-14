# Notes d'Implémentation : Détection Hybride

## Contexte

L'approche initiale utilisait uniquement des Z-scores calculés sur l'historique local des trades stockés dans TimescaleDB. Cette approche présentait plusieurs limitations :

1. **Délai d'accumulation** : Nécessitait 30+ trades avant d'avoir des statistiques significatives
2. **Faux positifs** : Un whale qui trade normalement de gros montants déclenchait des alertes
3. **Manque de contexte** : Pas de distinction entre "gros trade pour le marché" vs "gros trade pour ce wallet"

## Solution : Approche Hybride à Deux Niveaux

### Niveau 1 : Marché (Polymarket Gamma API)

**Fichier** : `src/blockchain/PolymarketAPI.ts`

```typescript
async getMarket(conditionId: string): Promise<PolymarketMarketData | null>
```

**Avantages** :
- Données de prix en temps réel sans délai
- Source de vérité officielle de Polymarket
- Inclut bestBid, bestAsk, volume24h, liquidity

**Implémentation** :
```typescript
// Calcul du mid-price
const midPrice = (bestBid + bestAsk) / 2;

// Déviation du trade
const deviationPercent = Math.abs(trade.price - midPrice) / midPrice * 100;

// Anomalie si déviation > seuil
if (deviationPercent >= staticThresholdPercent) {
  return {
    type: 'RAPID_ODDS_SHIFT',
    severity: deviationPercent > 25 ? 'HIGH' : 'MEDIUM',
    // ...
  };
}
```

**Rate Limiting** :
- 100ms minimum entre les requêtes
- Throttling automatique via `sleep()`

### Niveau 2 : Wallet (Alchemy Asset Transfers)

**Fichier** : `src/blockchain/BlockchainAnalyzer.ts`

```typescript
async getWalletTradeHistory(address: string, maxCount = 100): Promise<WalletTradeHistory>
```

**Avantages** :
- Détecte les comportements inhabituels **pour un wallet spécifique**
- Réduit drastiquement les faux positifs
- Signal fort pour l'insider trading

**Implémentation** :
```typescript
// Récupération des transferts USDC du wallet
const transfers = await alchemy_getAssetTransfers({
  fromAddress: address,
  category: ['erc20'],
  maxCount: 100,
  order: 'desc'
});

// Filtrage USDC uniquement
const tradeSizes = transfers
  .filter(t => t.asset?.toLowerCase() === 'usdc')
  .map(t => t.value);

// Calcul des statistiques
const avgTradeSize = mean(tradeSizes);
const stddevTradeSize = stddev(tradeSizes);

// Z-score comportemental
const behavioralZScore = (currentTradeSize - avgTradeSize) / stddevTradeSize;
```

**Cache Redis** :
- Les profils de wallet sont cachés pour éviter les appels répétés
- TTL configurable via `SMART_MONEY_WALLET_CACHE_TTL`

## Architecture de Fallback

### Rapid Odds Shift

```
1. Polymarket API (mid-price deviation)
   ↓ échec ou indisponible
2. Z-score sur historique local (TimescaleDB)
   ↓ échec ou données insuffisantes
3. Seuil statique (% changement de prix)
```

### Whale Activity

```
1. Z-score comportemental (Alchemy historique wallet)
   ↓ échec ou données insuffisantes (<5 trades)
2. Z-score marché (TimescaleDB)
   ↓ échec ou données insuffisantes
3. Seuil statique (% liquidité ou taille absolue)
```

## Modifications des Fichiers

### 1. `src/blockchain/PolymarketAPI.ts` (NOUVEAU)

Client pour l'API REST Gamma de Polymarket.

**Méthodes** :
- `getMarket(conditionId)` : Récupère les données de marché en temps réel

**Rate Limiting** :
- 100ms minimum entre les appels
- Throttling automatique

### 2. `src/blockchain/BlockchainAnalyzer.ts` (MODIFIÉ)

Ajout de la méthode `getWalletTradeHistory()`.

**Nouvelles méthodes** :
- `getWalletTradeHistory(address, maxCount)` : Récupère l'historique des trades du wallet
- `calculateStdDev(values)` : Calcule l'écart-type

**Nouveaux types** :
```typescript
export interface WalletTradeHistory {
  address: string;
  tradeSizes: number[];
  tradeCount: number;
  avgTradeSize: number;
  stddevTradeSize: number;
}
```

### 3. `src/detectors/AnomalyDetector.ts` (MODIFIÉ)

Refactorisation des méthodes de détection pour utiliser l'approche hybride.

**Changements** :
- `detectRapidOddsShift()` : Maintenant `async`, utilise PolymarketAPI en priorité
- `detectWhaleActivity()` : Maintenant `async`, utilise Z-score comportemental en priorité
- Ajout de `polymarketAPI` dans le constructeur

**Signatures modifiées** :
```typescript
async detectRapidOddsShift(...): Promise<Anomaly | null>
async detectWhaleActivity(...): Promise<Anomaly | null>
```

### 4. `src/analyzer/index.ts` (MODIFIÉ)

Intégration du `PolymarketAPI` dans le service.

**Changements** :
- Ajout de `polymarketAPI: PolymarketAPI | null`
- Instanciation dans `start()` : `this.polymarketAPI = new PolymarketAPI(this.logger)`
- Passage à `AnomalyDetector` dans le constructeur

## Tests

### Fichier : `tests/integration/hybrid-detection.test.ts`

**Scénarios testés** :

1. **Market-Level Detection**
   - Détection via Polymarket API
   - Fallback vers données locales

2. **Wallet-Level Behavioral**
   - Détection d'un petit trader qui fait un gros trade (anomalie)
   - Whale qui trade normalement (pas d'anomalie)
   - Fallback quand historique insuffisant

3. **Insider Trading**
   - Combinaison des signaux marché + wallet

**Mocking** :
- `polymarketAPI.getMarket()` : Retourne des données de marché simulées
- `blockchainAnalyzer.getWalletTradeHistory()` : Retourne un historique simulé
- `blockchainAnalyzer.analyzeWalletProfile()` : Retourne un profil simulé

## Performance

### Latence Ajoutée

- **Polymarket API** : ~100-200ms par trade
- **Alchemy historique** : ~200-300ms par wallet (avec cache)
- **Total** : +300-500ms par trade analysé

### Optimisations

1. **Cache Redis** :
   - Profils de wallet : 24h TTL
   - Évite les appels répétés pour le même wallet

2. **Rate Limiting** :
   - Polymarket : 100ms entre requêtes
   - Alchemy : 200ms entre requêtes (existant)

3. **Fallback Rapide** :
   - Timeout de 5s sur les appels API
   - Bascule immédiate vers fallback en cas d'échec

### Métriques Attendues

En conditions normales :
- **Polymarket API disponible** : >99%
- **Alchemy disponible** : >98%
- **Fallback vers seuils statiques** : <1%

## Configuration

Aucune nouvelle variable d'environnement requise. Les seuils existants sont réutilisés :

```env
# Utilisé pour la déviation du mid-price Polymarket
RAPID_ODDS_SHIFT_PERCENT=15

# Utilisé pour le Z-score comportemental
ZSCORE_THRESHOLD=3.0
ZSCORE_MIN_SAMPLES=5

# Utilisé pour les fallbacks
WHALE_ACTIVITY_PERCENT=20
INSIDER_MIN_TRADE_SIZE=10000
```

## Migration

### Compatibilité Ascendante

✅ **Aucun breaking change**

- Les méthodes existantes conservent leurs signatures (sauf `async`)
- Les fallbacks garantissent le fonctionnement même si les APIs externes échouent
- Les tests existants continuent de passer

### Déploiement

1. `npm install` (aucune nouvelle dépendance)
2. `npm run build`
3. `pm2 restart ecosystem.config.js`

Aucune modification de configuration requise.

## Monitoring

### Logs à Surveiller

```typescript
// Succès Polymarket API
logger.debug('Using Polymarket API for rapid odds shift detection', { marketId });

// Fallback vers données locales
logger.warn('Polymarket API unavailable, using local price history', { marketId });

// Succès Z-score comportemental
logger.debug('Using behavioral Z-score for whale detection', { walletAddress });

// Fallback vers Z-score marché
logger.warn('Insufficient wallet history, using market-level Z-score', { walletAddress });
```

### Métriques Clés

- **Taux d'utilisation Polymarket API** : % de trades utilisant l'API vs fallback
- **Taux d'utilisation Z-score comportemental** : % de trades avec historique wallet suffisant
- **Latence moyenne** : Temps de traitement par trade
- **Taux de faux positifs** : Alertes whale sur des whales connus

## Améliorations Futures

### Court Terme

1. **Cache Polymarket API** : Cacher les données de marché pendant 10-30s
2. **Batch Alchemy Requests** : Récupérer plusieurs historiques en parallèle
3. **Métriques Prometheus** : Exposer les taux de fallback et latences

### Moyen Terme

1. **Machine Learning** : Entraîner un modèle sur les patterns de trading
2. **Graph Analysis** : Analyser les réseaux de wallets connectés
3. **Sentiment Analysis** : Intégrer les données Twitter/Discord

### Long Terme

1. **Predictive Alerts** : Alerter avant qu'un événement ne se produise
2. **Auto-Tuning** : Ajuster automatiquement les seuils selon les performances
3. **Multi-Chain** : Étendre à d'autres blockchains (Ethereum, Arbitrum)

## Références

- [Polymarket Gamma API](https://gamma-api.polymarket.com)
- [Alchemy Asset Transfers](https://docs.alchemy.com/reference/alchemy-getassettransfers)
- [Z-Score Detection](https://en.wikipedia.org/wiki/Standard_score)
- [Behavioral Finance](https://en.wikipedia.org/wiki/Behavioral_economics)
