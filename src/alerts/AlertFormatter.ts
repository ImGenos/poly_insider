import { Anomaly, ClusterAnomaly, FilteredTrade, TelegramMessage } from '../types/index';
import { escapeMarkdown } from '../utils/helpers';
import { ExchangeRateService } from '../utils/ExchangeRateService';
import { Logger } from '../utils/Logger';
import type { AccumulationAnomaly } from '../detectors/AccumulationDetector';

const POLYGONSCAN_BASE = 'https://polygonscan.com/address';
const POLYMARKET_BASE  = 'https://polymarket.com/event';
const MAX_MESSAGE_LENGTH = 4096;

const fxService = ExchangeRateService.getInstance();

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

function formatEur(sizeUSDC: number): string {
  const eur = sizeUSDC * fxService.getCachedRate();
  const formatted = eur.toLocaleString('fr-FR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return escapeMarkdown(formatted + ' €');
}

function polygonScanLink(address: string): string {
  const short = `${address.slice(0, 6)}...${address.slice(-4)}`;
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
  async init(_logger?: Logger): Promise<void> {
    await fxService.getUsdToEurRate();
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
      parse_mode: 'Markdown',
      disable_web_page_preview: false,
    };
  }

  formatMegaTradeAlert(trade: FilteredTrade): TelegramMessage {
    const text = [
      `🐳 *MEGA TRADE DÉTECTÉ*`,
      ``,
      `Marché : ${polymarketLink(trade.marketId, trade.marketName)}`,
      `Position : *${sideFr(trade.side)}*`,
      `Montant : *${formatEur(trade.sizeUSDC)}*`,
      `Prix : *${escapeMarkdown((trade.price * 100).toFixed(1))}%*`,
      ``,
      `Portefeuille : ${trade.walletAddress ? polygonScanLink(trade.walletAddress) : 'N/A'}`,
    ].join('\n');

    return {
      text: truncate(text),
      parse_mode: 'Markdown',
      disable_web_page_preview: false,
    };
  }

  formatRapidOddsShift(anomaly: Anomaly, trade: FilteredTrade): string {
    const emoji   = severityEmoji(anomaly.severity);
    const metrics = anomaly.details.metrics as Record<string, unknown>;
    const zScore  = metrics.zScore as number | undefined;

    let detectionInfo: string;
    if (zScore !== undefined && zScore !== null) {
      detectionInfo = `Z\\-score : *${escapeMarkdown(zScore.toFixed(2))}σ*`;
    } else {
      const pctChange = metrics.priceChangePercent as number | undefined;
      detectionInfo = pctChange !== undefined
        ? `Variation de cote : *${escapeMarkdown(pctChange.toFixed(1))}%* \\(seuil statique\\)`
        : `Seuil statique déclenché`;
    }

    return [
      `${emoji} *GLISSEMENT DE COTE RAPIDE* \\| ${escapeMarkdown(severityFr(anomaly.severity))}`,
      ``,
      `Marché : ${polymarketLink(trade.marketId, trade.marketName)}`,
      `Position : *${sideFr(trade.side)}*`,
      `Montant : *${formatEur(trade.sizeUSDC)}*`,
      `${detectionInfo}`,
      `Confiance : *${escapeMarkdown((anomaly.confidence * 100).toFixed(0))}%*`,
      ``,
      `Portefeuille : ${trade.walletAddress ? polygonScanLink(trade.walletAddress) : 'N/A'}`,
    ].join('\n');
  }

  formatWhaleAlert(anomaly: Anomaly, trade: FilteredTrade): string {
    const emoji        = severityEmoji(anomaly.severity);
    const metrics      = anomaly.details.metrics as Record<string, unknown>;
    const zScore       = metrics.zScore as number | undefined;
    const liquidityPct = metrics.liquidityConsumedPercent as number | undefined;

    const lines = [
      `${emoji} *ACTIVITÉ BALEINE* \\| ${escapeMarkdown(severityFr(anomaly.severity))}`,
      ``,
      `Marché : ${polymarketLink(trade.marketId, trade.marketName)}`,
      `Position : *${sideFr(trade.side)}*`,
      `Montant : *${formatEur(trade.sizeUSDC)}*`,
    ];

    if (liquidityPct !== undefined) {
      lines.push(`Liquidité consommée : *${escapeMarkdown(liquidityPct.toFixed(1))}%*`);
    }

    if (zScore !== undefined && zScore !== null) {
      lines.push(`Z\\-score : *${escapeMarkdown(zScore.toFixed(2))}σ*`);
    }

    lines.push(`Confiance : *${escapeMarkdown((anomaly.confidence * 100).toFixed(0))}%*`);
    lines.push(``);
    lines.push(`Portefeuille : ${trade.walletAddress ? polygonScanLink(trade.walletAddress) : 'N/A'}`);

    return lines.join('\n');
  }

  formatInsiderAlert(anomaly: Anomaly, trade: FilteredTrade): string {
    const emoji     = severityEmoji(anomaly.severity);
    const metrics   = anomaly.details.metrics as Record<string, unknown>;
    const walletAge = metrics.ageHours as number | undefined;
    const txCount   = metrics.transactionCount as number | undefined;
    const riskScore = metrics.riskScore as number | undefined;

    const lines = [
      `${emoji} *DÉLIT D'INITIÉ* \\| ${escapeMarkdown(severityFr(anomaly.severity))}`,
      ``,
      `Marché : ${polymarketLink(trade.marketId, trade.marketName)}`,
      `Position : *${sideFr(trade.side)}*`,
      `Montant : *${formatEur(trade.sizeUSDC)}*`,
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
    lines.push(`Portefeuille : ${trade.walletAddress ? polygonScanLink(trade.walletAddress) : 'N/A'}`);

    return lines.join('\n');
  }

  formatClusterAlert(anomaly: ClusterAnomaly): string {
    const emoji = severityEmoji(anomaly.severity);

    const lines = [
      `${emoji} *CLUSTER DE PORTEFEUILLES COORDONNÉS* \\| ${escapeMarkdown(severityFr(anomaly.severity))}`,
      ``,
      `Marché : ${polymarketLink(anomaly.marketId, anomaly.marketName)}`,
      `Position : *${sideFr(anomaly.side)}*`,
      `Montant total : *${formatEur(anomaly.totalSizeUSDC)}*`,
      `Portefeuilles : *${escapeMarkdown(String(anomaly.wallets.length))}* en *${escapeMarkdown(String(anomaly.windowMinutes))} min*`,
    ];

    if (anomaly.severity === 'CRITICAL' && anomaly.fundingAnalysis?.commonFunderAddress) {
      const funder = anomaly.fundingAnalysis.commonFunderAddress;
      lines.push(``);
      lines.push(`*Common Funder:*`);
      lines.push(`${polygonScanLink(funder)}`);
      lines.push(``);
      lines.push(`*Funded Wallets:*`);
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
      parse_mode: 'Markdown',
      disable_web_page_preview: false,
    };
  }

  // ─── Accumulation alert (gradual limit-order position building) ───────────

  formatAccumulationAlert(anomaly: AccumulationAnomaly, trade: FilteredTrade): string {
    const emoji = severityEmoji(anomaly.severity);
    const ctx   = anomaly.accumulationContext;

    const lines = [
      `${emoji} *ACCUMULATION SILENCIEUSE* \\| ${escapeMarkdown(severityFr(anomaly.severity))}`,
      ``,
      `📈 *Position construite via ordres à cours limité*`,
      `Marché : ${polymarketLink(trade.marketId, trade.marketName)}`,
      `Position : *${sideFr(trade.side)}*`,
      `Total accumulé : *${formatEur(ctx.totalSizeUsd)}*`,
      `Fenêtre : *${escapeMarkdown(ctx.windowHours.toFixed(1))}h*`,
      ``,
      `*Profil du portefeuille :*`,
      `• Volume historique total : *${formatEur(ctx.walletTotalVolumeUsdc)}*`,
      `• Marchés distincts : *${escapeMarkdown(String(ctx.walletDistinctMarkets))}*`,
      `• Premier pari sur ce marché : *${ctx.isFirstTimeOnThisMarket ? 'OUI ⚠️' : 'Non'}*`,
      ``,
      `Portefeuille : ${trade.walletAddress ? polygonScanLink(trade.walletAddress) : 'N/A'}`,
    ];

    return lines.join('\n');
  }

  formatAccumulationMessage(anomaly: AccumulationAnomaly, trade: FilteredTrade): TelegramMessage {
    return {
      text: truncate(this.formatAccumulationAlert(anomaly, trade)),
      parse_mode: 'Markdown',
      disable_web_page_preview: false,
    };
  }

  formatSmartMoneyAlert(alert: SmartMoneyAlert): string {
    const emoji = severityEmoji(alert.severity);
    const ci    = alert.confidenceIndex;

    const lines = [
      `${emoji} *ARGENT INTELLIGENT DÉTECTÉ* \\| ${escapeMarkdown(severityFr(alert.severity))}`,
      ``,
      `🧠 *Marché non-sport*`,
      `Marché : ${polymarketLink(alert.marketId, alert.marketName)}`,
      `Position : *${sideFr(alert.side)}*`,
      `Montant : *${formatEur(alert.amount)}*`,
      `Prix : *${escapeMarkdown((alert.price * 100).toFixed(1))}%*`,
      ``,
      `📊 *Indice de confiance du parieur : ${escapeMarkdown(String(ci.score))}/100*`,
      ``,
      `*Métriques :*`,
      `• Volume récent 30j : *${formatEur(ci.metrics.recentVolume)}* \\(score : ${escapeMarkdown(ci.metrics.volumeScore.toFixed(0))}\\)`,
      `• Ratio mise : *${escapeMarkdown(ci.metrics.betSizeRatio.toFixed(2))}x* \\(score : ${escapeMarkdown(ci.metrics.betSizeScore.toFixed(0))}\\)`,
      `• Régularité \\(CV\\) : *${escapeMarkdown(ci.metrics.regularityCV.toFixed(2))}* \\(score : ${escapeMarkdown(ci.metrics.regularityScore.toFixed(0))}\\)`,
      ``,
      `Portefeuille : ${polygonScanLink(alert.walletAddress)}`,
    ];

    return lines.join('\n');
  }

  formatSmartMoneyMessage(alert: SmartMoneyAlert): TelegramMessage {
    return {
      text: truncate(this.formatSmartMoneyAlert(alert)),
      parse_mode: 'Markdown',
      disable_web_page_preview: false,
    };
  }
}

// ─── Local type (mirrors SmartMoneyAlert from SmartMoneyDetector) ─────────────

interface SmartMoneyAlert {
  marketId: string;
  marketName: string;
  side: 'YES' | 'NO';
  amount: number;
  price: number;
  walletAddress: string;
  confidenceIndex: {
    score: number;
    metrics: {
      recentVolume: number;
      volumeScore: number;
      betSizeRatio: number;
      betSizeScore: number;
      regularityCV: number;
      regularityScore: number;
    };
  };
  severity: string;
  detectedAt: Date;
}
