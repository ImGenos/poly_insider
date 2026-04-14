# Nettoyage des Tests - Approche Hybride

## Tests Supprimés

### 1. `tests/unit/AnomalyDetector.test.ts` ❌

**Raison** : Obsolète avec l'approche hybride

**Problèmes** :
- Testait l'ancienne approche Z-score uniquement (sans Polymarket API ni Z-score comportemental)
- Les méthodes `detectRapidOddsShift` et `detectWhaleActivity` sont maintenant `async` et utilisent des APIs externes
- Les tests mockaient des comportements qui n'existent plus (Z-score marché uniquement)
- Ne testait pas les fallbacks en cascade (Polymarket API → Z-score local → seuil statique)

**Remplacé par** : `tests/integration/hybrid-detection.test.ts`

Le nouveau test couvre :
- ✅ Détection via Polymarket API (niveau marché)
- ✅ Z-score comportemental via Alchemy (niveau wallet)
- ✅ Fallbacks en cascade
- ✅ Scénarios d'insider trading avec signaux combinés

### 2. `tests/property/AnomalyDetector.property.test.ts` ❌

**Raison** : Obsolète avec l'approche hybride

**Problèmes** :
- Property tests basés sur l'ancienne logique Z-score marché uniquement
- Ne testait pas les appels API externes (Polymarket, Alchemy)
- Les propriétés testées (confidence bounds, Z-score thresholds) sont maintenant différentes avec l'approche hybride
- Les arbitraires (générateurs de données aléatoires) ne correspondent plus aux nouvelles signatures de méthodes

**Pourquoi pas remplacé** :
- Les property tests pour l'approche hybride nécessiteraient des mocks complexes d'APIs externes
- Les tests d'intégration `hybrid-detection.test.ts` couvrent mieux les scénarios réels
- Les tests de graceful degradation couvrent les cas limites et fallbacks

## Tests Conservés et Mis à Jour

### 1. `tests/integration/graceful-degradation.test.ts` ✅

**Mis à jour pour** :
- Inclure `PolymarketAPI` dans les mocks
- Tester les fallbacks avec la nouvelle approche hybride
- Ajouter `getWalletTradeHistory` dans les mocks BlockchainAnalyzer

**Couvre** :
- ✅ Fallback quand TimescaleDB indisponible
- ✅ Fallback quand Alchemy indisponible
- ✅ Fallback quand Polymarket API indisponible
- ✅ Deduplication in-memory quand Redis indisponible

### 2. `tests/unit/BlockchainAnalyzer.test.ts` ✅

**Conservé** : Toujours pertinent

**Raison** :
- Teste la logique de cache wallet profiles (inchangée)
- Teste les fallbacks Alchemy → Moralis (inchangée)
- Teste l'analyse de funding clusters (inchangée)
- La nouvelle méthode `getWalletTradeHistory` suit les mêmes patterns

### 3. `tests/property/BlockchainAnalyzer.property.test.ts` ✅

**Conservé** : Toujours pertinent

**Raison** :
- Property tests sur le caching (toujours valide)
- Property tests sur la non-blocking funding analysis (toujours valide)
- Pas affecté par l'approche hybride

### 4. Autres tests conservés ✅

- `tests/integration/e2e.test.ts` - Tests end-to-end
- `tests/integration/redis-stream.test.ts` - Tests Redis Stream
- `tests/integration/websocket-reconnection.test.ts` - Tests WebSocket
- `tests/unit/*` (autres) - Tests unitaires non affectés
- `tests/property/*` (autres) - Property tests non affectés

## Nouveau Test Ajouté

### `tests/integration/hybrid-detection.test.ts` ✨

**Couvre** :

#### Niveau Marché (Polymarket API)
- ✅ Détection rapid odds shift via mid-price Polymarket
- ✅ Fallback vers historique local quand API indisponible
- ✅ Métriques incluant bestBid, bestAsk, volume24h, liquidity

#### Niveau Wallet (Z-score Comportemental)
- ✅ Détection whale activity via historique wallet Alchemy
- ✅ Petit trader qui fait un gros trade → anomalie
- ✅ Whale qui trade normalement → pas d'anomalie
- ✅ Fallback vers Z-score marché quand historique insuffisant

#### Insider Trading Combiné
- ✅ Nouveau wallet + gros trade + déviation marché
- ✅ Signaux combinés des deux niveaux
- ✅ Confidence score élevé

## Résumé

### Tests Supprimés : 2
- `tests/unit/AnomalyDetector.test.ts`
- `tests/property/AnomalyDetector.property.test.ts`

### Tests Ajoutés : 1
- `tests/integration/hybrid-detection.test.ts`

### Tests Mis à Jour : 1
- `tests/integration/graceful-degradation.test.ts`

### Tests Conservés : ~20+
- Tous les autres tests restent pertinents

## Couverture de Tests

### Avant (Approche Z-score Marché)
- ✅ Z-score sur historique local
- ✅ Seuils statiques
- ✅ Fallbacks basiques
- ❌ Pas de données temps réel
- ❌ Pas de contexte comportemental wallet

### Après (Approche Hybride)
- ✅ Polymarket API (données temps réel)
- ✅ Z-score comportemental (historique wallet)
- ✅ Fallbacks en cascade (3 niveaux)
- ✅ Détection insider trading améliorée
- ✅ Réduction faux positifs

## Commandes de Test

```bash
# Tous les tests
npm test

# Tests unitaires uniquement
npm run test:unit

# Tests d'intégration uniquement
npm run test:integration

# Tests property-based uniquement
npm run test:property

# Test spécifique
npm test -- hybrid-detection.test.ts
```

## Prochaines Étapes

### Court Terme
- [ ] Ajouter des tests pour `PolymarketAPI.getMarket()`
- [ ] Ajouter des tests pour `BlockchainAnalyzer.getWalletTradeHistory()`

### Moyen Terme
- [ ] Property tests pour l'approche hybride (si nécessaire)
- [ ] Tests de performance (latence API)
- [ ] Tests de charge (rate limiting)

### Long Terme
- [ ] Tests E2E avec vraies APIs (staging)
- [ ] Tests de régression automatisés
- [ ] Benchmarks de précision (faux positifs/négatifs)

---

**Date** : 2026-04-14  
**Version** : 2.0.0  
**Auteur** : Kiro AI Assistant
