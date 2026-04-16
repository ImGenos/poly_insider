import { Anomaly, ClusterAnomaly, FilteredTrade, TelegramMessage } from '../types/index';
import { SmartMoneyAlert } from '../detectors/SmartMoneyDetector';
import { escapeMarkdown } from '../utils/helpers';
import { ExchangeRateService } from '../utils/ExchangeRateService';
import { Logger } from '../utils/Logger';

const POLYGONSCAN_BASE = 'https://polygonscan.com/address';
const POLYMARKET_BASE = 'https://polymarket.com/event';
const MAX_MESSAGE_LENGTH = 4096;

function severityEmoji(severity: string): string {
  if (severity === 'HIGH' || severity === 'CRITICAL') return '🚨';
  if (severity === 'MEDIUM') return '⚠️';
  return 'ℹ️';
}

function severityFr(severity: string): string {
  switch (severity) {
    case 'CRITICAL': return 'CRITIQUE';
    case 'HIGH':     return 'ÉLEVÉ';
    case 'MEDIUM':   return 'MOYEN';
    case 'LOW':      return 'FAIBLE';
    default:         return severity;
  }
}

function sideFr(side: string): string {
  return side === 'YES' ? 'OUI' : 'NON';
}

/** Returns the position label: outcome name + side when outcome is known, plain OUI/NON otherwise. */
function positionLabel(trade: FilteredTrade): string {
  if (trade.outcome) {
    return `${trade.outcome} (${sideFr(trade.side)})`;
  }
  return sideFr(trade.side);
}

/** Convertit un montant USDC en euros et le formate en français (taux en cache) */
function formatEur(sizeUSDC: number, rate: number): string {
  const eur = sizeUSDC * rate;
  const formatted = eur.toLocaleString('fr-FR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return escapeMarkdown(formatted + ' €');
}

function polygonScanLink(address: string): string {
  const short = `${address.slice(0, 6)}…${address.slice(-4)}`;
  return `[${escapeMarkdown(short)}](${POLYGONSCAN_BASE}/${address})`;
}

function polymarketLink(marketId: string, marketName: string): string {
  return `[${escapeMarkdown(marketName)}](${POLYMARKET_BASE}/${marketId})`;
}

function truncate(text: string): string {
  if (text.length <= MAX_MESSAGE_LENGTH) return text;
  const boundary = text.lastIndexOf('\n', MAX_MESSAGE_LENGTH - 4);
  const cutAt = boundary > 0 ? boundary : MAX_MESSAGE_LENGTH - 4;
  return text.slice(0, cutAt) + '\n...';
}

export class AlertFormatter {
  private fxService: ExchangeRateService = ExchangeRateService.getInstance();

  /**
   * Pré-charge le taux de change USD→EUR au démarrage.
   * À appeler une fois lors de l'initialisation du service.
   */
  async init(logger?: Logger): Promise<void> {
    this.fxService = ExchangeRateService.getInstance(logger);
    await this.fxService.getUsdToEurRate();
  }

  format(anomaly: Anomaly, trade: FilteredTrade): TelegramMessage {
    let text: string;

    switch (anomaly.type) {
      case 'RAPID_ODDS_SHIFT':
        text = this.formatRapidOddsShift(anomaly, trade);
        break;
      case 'WHALE_ACTIVITY':
        text = this.formatWhaleAlert(anomaly, trade);
        break;
      case 'INSIDER_TRADING':
        text = this.formatInsiderAlert(anomaly, trade);
        break;
      default:
        text = this.formatRapidOddsShift(anomaly, trade);
    }

    return {
      text: truncate(text),
      parse_mode: 'MarkdownV2',
      disable_web_page_preview: false,
    };
  }

  formatRapidOddsShift(anomaly: Anomaly, trade: FilteredTrade): string {
    const emoji = severityEmoji(anomaly.severity);
    const metrics = anomaly.details.metrics as Record<string, unknown>;
    const zScore = metrics.zScore as number | undefined;
    const rate = this.fxService.getCachedRate();

    let detectionInfo: string;
    if (zScore !== undefined && zScore !== null) {
      detectionInfo = `Z-score : *${escapeMarkdown(zScore.toFixed(2))}σ*`;
    } else {
      const pctChange = metrics.priceChangePercent as number | undefined;
      detectionInfo = pctChange !== undefined
        ? `Variation de cote : *${escapeMarkdown(pctChange.toFixed(1))}%* (seuil statique)`
        : `Seuil statique déclenché`;
    }

    return [
      `${emoji} *${escapeMarkdown('GLISSEMENT DE COTE RAPIDE')}* ${escapeMarkdown('|')} ${escapeMarkdown(severityFr(anomaly.severity))}`,
      ``,
      `Marché : ${polymarketLink(trade.marketId, trade.marketName)}`,
      `Position : *${escapeMarkdown(positionLabel(trade))}*`,
      `Montant : *${formatEur(trade.sizeUSDC, rate)}*`,
      `${detectionInfo}`,
      `Confiance : *${escapeMarkdown((anomaly.confidence * 100).toFixed(0))}%*`,
      ``,
      ...(trade.walletAddress ? [`Portefeuille : ${polygonScanLink(trade.walletAddress)}`] : []),
    ].join('\n');
  }

  formatWhaleAlert(anomaly: Anomaly, trade: FilteredTrade): string {
    const emoji = severityEmoji(anomaly.severity);
    const metrics = anomaly.details.metrics as Record<string, unknown>;
    const zScore = metrics.zScore as number | undefined;
    const liquidityPct = metrics.liquidityConsumedPercent as number | undefined;
    const rate = this.fxService.getCachedRate();

    const lines = [
      `${emoji} *${escapeMarkdown('ACTIVITÉ BALEINE')}* ${escapeMarkdown('|')} ${escapeMarkdown(severityFr(anomaly.severity))}`,
      ``,
      `Marché : ${polymarketLink(trade.marketId, trade.marketName)}`,
      `Position : *${escapeMarkdown(positionLabel(trade))}*`,
      `Montant : *${formatEur(trade.sizeUSDC, rate)}*`,
    ];

    if (liquidityPct !== undefined) {
      lines.push(`Liquidité consommée : *${escapeMarkdown(liquidityPct.toFixed(1))}%*`);
    }

    if (zScore !== undefined && zScore !== null) {
      lines.push(`Z-score : *${escapeMarkdown(zScore.toFixed(2))}σ*`);
    }

    lines.push(`Confiance : *${escapeMarkdown((anomaly.confidence * 100).toFixed(0))}%*`);
    lines.push(``);
    if (trade.walletAddress) {
      lines.push(`Portefeuille : ${polygonScanLink(trade.walletAddress)}`);
    }

    return lines.join('\n');
  }

  formatInsiderAlert(anomaly: Anomaly, trade: FilteredTrade): string {
    const emoji = severityEmoji(anomaly.severity);
    const metrics = anomaly.details.metrics as Record<string, unknown>;
    const walletAge = metrics.ageHours as number | undefined;
    const txCount = metrics.transactionCount as number | undefined;
    const riskScore = metrics.riskScore as number | undefined;
    const rate = this.fxService.getCachedRate();

    const lines = [
      `${emoji} *${escapeMarkdown('DÉLIT D\'INITIÉ')}* ${escapeMarkdown('|')} ${escapeMarkdown(severityFr(anomaly.severity))}`,
      ``,
      `Marché : ${polymarketLink(trade.marketId, trade.marketName)}`,
      `Position : *${escapeMarkdown(positionLabel(trade))}*`,
      `Montant : *${formatEur(trade.sizeUSDC, rate)}*`,
    ];

    if (walletAge !== undefined) {
      lines.push(`Âge du portefeuille : *${escapeMarkdown(walletAge.toFixed(1))}h*`);
    }
    if (txCount !== undefined) {
      lines.push(`Nb de transactions : *${escapeMarkdown(String(txCount))}*`);
    }
    if (riskScore !== undefined) {
      lines.push(`Score de risque : *${escapeMarkdown(String(riskScore))}/100*`);
    }

    lines.push(`Confiance : *${escapeMarkdown((anomaly.confidence * 100).toFixed(0))}%*`);
    lines.push(``);
    if (trade.walletAddress) {
      lines.push(`Portefeuille : ${polygonScanLink(trade.walletAddress)}`);
    }

    return lines.join('\n');
  }

  formatClusterAlert(anomaly: ClusterAnomaly): string {
    const emoji = severityEmoji(anomaly.severity);
    const rate = this.fxService.getCachedRate();

    const lines = [
      `${emoji} *CLUSTER DE PORTEFEUILLES COORDONNÉS* | ${escapeMarkdown(severityFr(anomaly.severity))}`,
      ``,
      `Marché : ${polymarketLink(anomaly.marketId, anomaly.marketName)}`,
      `Position : *${sideFr(anomaly.side)}*`,
      `Montant total : *${formatEur(anomaly.totalSizeUSDC, rate)}*`,
      `Portefeuilles : *${escapeMarkdown(String(anomaly.wallets.length))}* en *${escapeMarkdown(String(anomaly.windowMinutes))} min*`,
    ];

    if (anomaly.severity === 'CRITICAL' && anomaly.fundingAnalysis?.commonFunderAddress) {
      const funder = anomaly.fundingAnalysis.commonFunderAddress;
      lines.push(``);
      lines.push(`*Financeur commun :*`);
      lines.push(`${polygonScanLink(funder)}`);
      lines.push(``);
      lines.push(`*Portefeuilles financés :*`);
      for (const wallet of anomaly.wallets) {
        lines.push(`• ${polygonScanLink(wallet)}`);
      }
    } else {
      lines.push(``);
      lines.push(`*Portefeuilles :*`);
      for (const wallet of anomaly.wallets) {
        lines.push(`• ${polygonScanLink(wallet)}`);
      }
    }

    return lines.join('\n');
  }

  formatClusterMessage(anomaly: ClusterAnomaly): TelegramMessage {
    return {
      text: truncate(this.formatClusterAlert(anomaly)),
      parse_mode: 'MarkdownV2',
      disable_web_page_preview: false,
    };
  }

  formatSmartMoneyAlert(alert: SmartMoneyAlert): string {
    const emoji = severityEmoji(alert.severity);
    const ci = alert.confidenceIndex;
    const rate = this.fxService.getCachedRate();

    const lines = [
      `${emoji} *ARGENT INTELLIGENT DÉTECTÉ* | ${escapeMarkdown(severityFr(alert.severity))}`,
      ``,
      `⚽ *Marché Football*`,
      `Marché : ${polymarketLink(alert.marketId, alert.marketName)}`,
      `Position : *${sideFr(alert.side)}*`,
      `Montant : *${formatEur(alert.amount, rate)}*`,
      `Prix : *${escapeMarkdown((alert.price * 100).toFixed(1))}%*`,
      ``,
      `📊 *Indice de confiance du parieur : ${escapeMarkdown(String(ci.score))}/100*`,
      ``,
      `*Métriques :*`,
      `• Volume récent : *${formatEur(ci.metrics.recentVolume, rate)}* (score : ${escapeMarkdown(ci.metrics.volumeScore.toFixed(0))})`,
      `• Ratio mise : *${escapeMarkdown(ci.metrics.betSizeRatio.toFixed(2))}x* (score : ${escapeMarkdown(ci.metrics.betSizeScore.toFixed(0))})`,
      `• Régularité : *${escapeMarkdown((ci.metrics.activityConsistency * 100).toFixed(1))}%* (score : ${escapeMarkdown(ci.metrics.activityConsistencyScore.toFixed(0))})`,
      `• Transactions : *${escapeMarkdown(String(ci.metrics.transferCount))}*`,
      ``,
      `Portefeuille : ${polygonScanLink(alert.walletAddress)}`,
    ];

    return lines.join('\n');
  }

  formatSmartMoneyMessage(alert: SmartMoneyAlert): TelegramMessage {
    return {
      text: truncate(this.formatSmartMoneyAlert(alert)),
      parse_mode: 'MarkdownV2',
      disable_web_page_preview: false,
    };
  }

  formatMegaTradeAlert(trade: FilteredTrade): TelegramMessage {
    const rate = this.fxService.getCachedRate();
    
    const lines = [
      `💰 *${escapeMarkdown('MEGA TRADE')}* ${escapeMarkdown('|')} ${escapeMarkdown('≥ $30,000')}`,
      ``,
      `Marché : ${polymarketLink(trade.marketId, trade.marketName)}`,
      `Position : *${escapeMarkdown(positionLabel(trade))}*`,
      `Montant : *${formatEur(trade.sizeUSDC, rate)}*`,
      `Prix : *${escapeMarkdown((trade.price * 100).toFixed(1))}%*`,
      ``,
    ];

    if (trade.walletAddress) {
      lines.push(`Portefeuille : ${polygonScanLink(trade.walletAddress)}`);
    }

    return {
      text: truncate(lines.join('\n')),
      parse_mode: 'MarkdownV2',
      disable_web_page_preview: false,
    };
  }
}


