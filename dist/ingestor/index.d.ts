export declare class IngestorService {
    private readonly config;
    private readonly logger;
    private readonly redisCache;
    private readonly wsManager;
    constructor();
    start(): Promise<void>;
    stop(): Promise<void>;
    getStreamDepth(): Promise<number>;
}
export default function main(): Promise<void>;
//# sourceMappingURL=index.d.ts.map