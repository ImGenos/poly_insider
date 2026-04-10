import { Anomaly, ClusterAnomaly, FilteredTrade, TelegramMessage } from '../types/index';
export declare class AlertFormatter {
    format(anomaly: Anomaly, trade: FilteredTrade): TelegramMessage;
    formatRapidOddsShift(anomaly: Anomaly, trade: FilteredTrade): string;
    formatWhaleAlert(anomaly: Anomaly, trade: FilteredTrade): string;
    formatInsiderAlert(anomaly: Anomaly, trade: FilteredTrade): string;
    formatClusterAlert(anomaly: ClusterAnomaly): string;
    formatClusterMessage(anomaly: ClusterAnomaly): TelegramMessage;
}
//# sourceMappingURL=AlertFormatter.d.ts.map