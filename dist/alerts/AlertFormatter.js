"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AlertFormatter = void 0;
const helpers_1 = require("../utils/helpers");
const POLYGONSCAN_BASE = 'https://polygonscan.com/address';
const POLYMARKET_BASE = 'https://polymarket.com/event';
const MAX_MESSAGE_LENGTH = 4096;
function severityEmoji(severity) {
    if (severity === 'HIGH' || severity === 'CRITICAL')
        return '🚨';
    if (severity === 'MEDIUM')
        return '⚠️';
    return 'ℹ️';
}
function formatSize(sizeUSDC) {
    return sizeUSDC.toLocaleString('en-US', { maximumFractionDigits: 2 });
}
function polygonScanLink(address) {
    return `[${(0, helpers_1.escapeMarkdown)(address)}](${POLYGONSCAN_BASE}/${address})`;
}
function polymarketLink(marketId, marketName) {
    return `[${(0, helpers_1.escapeMarkdown)(marketName)}](${POLYMARKET_BASE}/${marketId})`;
}
function truncate(text) {
    if (text.length <= MAX_MESSAGE_LENGTH)
        return text;
    return text.slice(0, MAX_MESSAGE_LENGTH - 3) + '...';
}
class AlertFormatter {
    format(anomaly, trade) {
        let text;
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
    formatRapidOddsShift(anomaly, trade) {
        const emoji = severityEmoji(anomaly.severity);
        const metrics = anomaly.details.metrics;
        const zScore = metrics.zScore;
        let detectionInfo;
        if (zScore !== undefined && zScore !== null) {
            detectionInfo = `Z\\-score: *${zScore.toFixed(2)}σ*`;
        }
        else {
            const pctChange = metrics.priceChangePercent;
            detectionInfo = pctChange !== undefined
                ? `Price change: *${pctChange.toFixed(1)}%* \\(static threshold\\)`
                : `Static threshold triggered`;
        }
        return [
            `${emoji} *RAPID ODDS SHIFT* \\| ${(0, helpers_1.escapeMarkdown)(anomaly.severity)}`,
            ``,
            `Market: ${polymarketLink(trade.marketId, trade.marketName)}`,
            `Side: *${trade.side}*`,
            `Size: *$${formatSize(trade.sizeUSDC)} USDC*`,
            `${detectionInfo}`,
            `Confidence: *${(anomaly.confidence * 100).toFixed(0)}%*`,
            ``,
            `Wallet: ${polygonScanLink(trade.walletAddress)}`,
        ].join('\n');
    }
    formatWhaleAlert(anomaly, trade) {
        const emoji = severityEmoji(anomaly.severity);
        const metrics = anomaly.details.metrics;
        const zScore = metrics.zScore;
        const liquidityPct = metrics.liquidityConsumedPercent;
        const lines = [
            `${emoji} *WHALE ACTIVITY* \\| ${(0, helpers_1.escapeMarkdown)(anomaly.severity)}`,
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
        lines.push(`Wallet: ${polygonScanLink(trade.walletAddress)}`);
        return lines.join('\n');
    }
    formatInsiderAlert(anomaly, trade) {
        const emoji = severityEmoji(anomaly.severity);
        const metrics = anomaly.details.metrics;
        const walletAge = metrics.walletAgeHours;
        const txCount = metrics.transactionCount;
        const riskScore = metrics.riskScore;
        const lines = [
            `${emoji} *INSIDER TRADING* \\| ${(0, helpers_1.escapeMarkdown)(anomaly.severity)}`,
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
        lines.push(`Wallet: ${polygonScanLink(trade.walletAddress)}`);
        return lines.join('\n');
    }
    formatClusterAlert(anomaly) {
        const emoji = severityEmoji(anomaly.severity);
        const lines = [
            `${emoji} *COORDINATED WALLET CLUSTER* \\| ${(0, helpers_1.escapeMarkdown)(anomaly.severity)}`,
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
        }
        else {
            lines.push(``);
            lines.push(`*Wallets:*`);
            for (const wallet of anomaly.wallets) {
                lines.push(`• ${polygonScanLink(wallet)}`);
            }
        }
        return lines.join('\n');
    }
    formatClusterMessage(anomaly) {
        return {
            text: truncate(this.formatClusterAlert(anomaly)),
            parse_mode: 'Markdown',
            disable_web_page_preview: false,
        };
    }
}
exports.AlertFormatter = AlertFormatter;
//# sourceMappingURL=AlertFormatter.js.map