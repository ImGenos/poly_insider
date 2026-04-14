import { Anomaly, ClusterAnomaly, FilteredTrade, TelegramMessage } from '../types/index';
import { escapeMarkdown } from '../utils/helpers';

const POLYGONSCAN_BASE = 'https://polygonscan.com/address';
const POLYMARKET_BASE = 'https://polymarket.com/event';
const MAX_MESSAGE_LENGTH = 4096;

function severityEmoji(severity: string): string {
  if (severity === 'HIGH' || severity === 'CRITICAL') return '🚨';
  if (severity === 'MEDIUM') return '⚠️';
  return 'ℹ️';
}

function formatSize(sizeUSDC: number): string {
  return sizeUSDC.toLocaleString('en-US', { maximumFractionDigits: 2 });
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

    let detectionInfo: string;
    if (zScore !== undefined && zScore !== null) {
      detectionInfo = `Z\\-score: *${zScore.toFixed(2)}σ*`;
    } else {
      const pctChange = metrics.priceChangePercent as number | undefined;
      detectionInfo = pctChange !== undefined
        ? `Price change: *${pctChange.toFixed(1)}%* \\(static threshold\\)`
        : `Static threshold triggered`;
    }

    return [
      `${emoji} *RAPID ODDS SHIFT* \\| ${escapeMarkdown(anomaly.severity)}`,
      ``,
      `Market: ${polymarketLink(trade.marketId, trade.marketName)}`,
      `Side: *${trade.side}*`,
      `Size: *$${formatSize(trade.sizeUSDC)} USDC*`,
      `${detectionInfo}`,
      `Confidence: *${(anomaly.confidence * 100).toFixed(0)}%*`,
      ``,
      `Wallet: ${trade.walletAddress ? polygonScanLink(trade.walletAddress) : 'N/A'}`,
    ].join('\n');
  }

  formatWhaleAlert(anomaly: Anomaly, trade: FilteredTrade): string {
    const emoji = severityEmoji(anomaly.severity);
    const metrics = anomaly.details.metrics as Record<string, unknown>;
    const zScore = metrics.zScore as number | undefined;
    const liquidityPct = metrics.liquidityConsumedPercent as number | undefined;

    const lines = [
      `${emoji} *WHALE ACTIVITY* \\| ${escapeMarkdown(anomaly.severity)}`,
      ``,
      `Market: ${polymarketLink(trade.marketId, trade.marketName)}`,
      `Side: *${trade.side}*`,
      `Size: *$${formatSize(trade.sizeUSDC)} USDC*`,
    ];

    if (liquidityPct !== undefined) {
      lines.push(`Liquidity consumed: *${liquidityPct.toFixed(1)}%*`);
    }

    if (zScore !== undefined && zScore !== null) {
      lines.push(`Z\\-score: *${zScore.toFixed(2)}σ*`);
    }

    lines.push(`Confidence: *${(anomaly.confidence * 100).toFixed(0)}%*`);
    lines.push(``);
    lines.push(`Wallet: ${trade.walletAddress ? polygonScanLink(trade.walletAddress) : 'N/A'}`);

    return lines.join('\n');
  }

  formatInsiderAlert(anomaly: Anomaly, trade: FilteredTrade): string {
    const emoji = severityEmoji(anomaly.severity);
    const metrics = anomaly.details.metrics as Record<string, unknown>;
    const walletAge = metrics.ageHours as number | undefined;
    const txCount = metrics.transactionCount as number | undefined;
    const riskScore = metrics.riskScore as number | undefined;

    const lines = [
      `${emoji} *INSIDER TRADING* \\| ${escapeMarkdown(anomaly.severity)}`,
      ``,
      `Market: ${polymarketLink(trade.marketId, trade.marketName)}`,
      `Side: *${trade.side}*`,
      `Size: *$${formatSize(trade.sizeUSDC)} USDC*`,
    ];

    if (walletAge !== undefined) {
      lines.push(`Wallet age: *${walletAge.toFixed(1)}h*`);
    }
    if (txCount !== undefined) {
      lines.push(`Tx count: *${txCount}*`);
    }
    if (riskScore !== undefined) {
      lines.push(`Risk score: *${riskScore}/100*`);
    }

    lines.push(`Confidence: *${(anomaly.confidence * 100).toFixed(0)}%*`);
    lines.push(``);
    lines.push(`Wallet: ${trade.walletAddress ? polygonScanLink(trade.walletAddress) : 'N/A'}`);

    return lines.join('\n');
  }

  formatClusterAlert(anomaly: ClusterAnomaly): string {
    const emoji = severityEmoji(anomaly.severity);

    const lines = [
      `${emoji} *COORDINATED WALLET CLUSTER* \\| ${escapeMarkdown(anomaly.severity)}`,
      ``,
      `Market: ${polymarketLink(anomaly.marketId, anomaly.marketName)}`,
      `Side: *${anomaly.side}*`,
      `Total size: *$${formatSize(anomaly.totalSizeUSDC)} USDC*`,
      `Wallets: *${anomaly.wallets.length}* in last *${anomaly.windowMinutes}min*`,
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
      lines.push(`*Wallets:*`);
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

    const lines = [
      `${emoji} *SMART MONEY DETECTED* \\| ${escapeMarkdown(alert.severity)}`,
      ``,
      `⚽ *Football Market*`,
      `Market: ${polymarketLink(alert.marketId, alert.marketName)}`,
      `Side: *${alert.side}*`,
      `Amount: *${formatSize(alert.amount)} USDC*`,
      `Price: *${(alert.price * 100).toFixed(1)}%*`,
      ``,
      `📊 *Bettor Confidence Index: ${ci.score}/100*`,
      ``,
      `*Metrics:*`,
      `• PnL: *$${formatSize(ci.metrics.pnl)}* \\(score: ${ci.metrics.pnlScore.toFixed(0)}\\)`,
      `• Recent Volume: *$${formatSize(ci.metrics.recentVolume)}* \\(score: ${ci.metrics.volumeScore.toFixed(0)}\\)`,
      `• Bet Size Ratio: *${ci.metrics.betSizeRatio.toFixed(2)}x* \\(score: ${ci.metrics.betSizeScore.toFixed(0)}\\)`,
      `• Win Rate: *${(ci.metrics.winRate * 100).toFixed(1)}%* \\(score: ${ci.metrics.winRateScore.toFixed(0)}\\)`,
      ``,
      `Wallet: ${polygonScanLink(alert.walletAddress)}`,
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
}

// ─── Type Import for Smart Money ──────────────────────────────────────────

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
      pnl: number;
      pnlScore: number;
      recentVolume: number;
      volumeScore: number;
      betSizeRatio: number;
      betSizeScore: number;
      winRate: number;
      winRateScore: number;
    };
  };
  severity: string;
  detectedAt: Date;
}
