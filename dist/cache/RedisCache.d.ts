import { WalletProfile, StreamMessage } from '../types/index';
import { Logger } from '../utils/Logger';
export declare class RedisCache {
    private client;
    private readonly url;
    private readonly logger;
    isConnected: boolean;
    private readonly dedupMap;
    constructor(url: string, logger: Logger);
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    pushToStream(streamKey: string, fields: Record<string, string>): Promise<string>;
    createConsumerGroup(streamKey: string, group: string): Promise<void>;
    readFromStream(streamKey: string, group: string, consumer: string, count: number): Promise<StreamMessage[]>;
    acknowledgeMessage(streamKey: string, group: string, messageId: string): Promise<void>;
    getStreamDepth(streamKey: string): Promise<number>;
    getWalletProfile(address: string): Promise<WalletProfile | null>;
    saveWalletProfile(profile: WalletProfile): Promise<void>;
    getWalletFunder(address: string): Promise<string | null>;
    cacheWalletFunder(address: string, funder: string): Promise<void>;
    hasAlertBeenSent(type: string, marketId: string, walletAddress: string): Promise<boolean>;
    recordSentAlert(type: string, marketId: string, walletAddress: string, ttlSeconds: number): Promise<void>;
    hasClusterAlertBeenSent(marketId: string, side: string): Promise<boolean>;
    recordClusterAlert(marketId: string, side: string, ttlSeconds: number): Promise<void>;
}
//# sourceMappingURL=RedisCache.d.ts.map