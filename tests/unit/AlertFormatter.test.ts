import { AlertFormatter } from '../../src/alerts/AlertFormatter';
import { Anomaly, ClusterAnomaly, FilteredTrade, FundingAnalysis } from '../../src/types/index';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const formatter = new AlertFormatter();

function makeTrade(overrides: Partial<FilteredTrade> = {}): FilteredTrade {
  return {
    marketId: 'market-abc',
    marketName: 'Will BTC hit 100k?',
    side: 'YES',
    price: 0.65,
    sizeUSDC: 25000,
    timestamp: new Date('2024-01-15T12:00:00Z'),
    walletAddress: '0xaAbBcCdDeEfF0011223344556677889900aAbBcC',
    orderBookLiquidity: 200000,
    ...overrides,
  };
}

function makeAnomaly(overrides: Partial<Anomaly> = {}): Anomaly {
  return {
    type: 'RAPID_ODDS_SHIFT',
    severity: 'HIGH',
    confidence: 0.85,
    details: {
      description: 'Rapid price movement detected',
      metrics: { zScore: 4.2 },
    },
    detectedAt: new Date('2024-01-15T12:00:00Z'),
    ...overrides,
  };
}

function makeClusterAnomaly(overrides: Partial<ClusterAnomaly> = {}): ClusterAnomaly {
  return {
    type: 'COORDINATED_MOVE',
    marketId: 'market-abc',
    marketName: 'Will BTC hit 100k?',
    side: 'YES',
    wallets: [
      '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
    ],
    totalSizeUSDC: 75000,
    windowMinutes: 10,
    detectedAt: new Date('2024-01-15T12:00:00Z'),
    severity: 'HIGH',
    ...overrides,
  };
}

function makeNoFundingAnalysis(wallets: string[]): FundingAnalysis {
  return {
    wallets,
    funders: new Map(),
    sharedFunders: new Map(),
    hasCommonNonExchangeFunder: false,
    commonFunderAddress: null,
    isKnownExchange: false,
    exchangeName: null,
  };
}

function makeCommonFunderAnalysis(wallets: string[], funderAddress: string): FundingAnalysis {
  const funders = new Map<string, string>(wallets.map(w => [w, funderAddress]));
  const sharedFunders = new Map<string, string[]>([[funderAddress.toLowerCase(), wallets]]);
  return {
    wallets,
    funders,
    sharedFunders,
    hasCommonNonExchangeFunder: true,
    commonFunderAddress: funderAddress,
    isKnownExchange: false,
    exchangeName: null,
  };
}

// ─── Emoji selection per severity ────────────────────────────────────────────

describe('Emoji selection for each severity level (Req 10.1)', () => {
  it('uses 🚨 for HIGH severity', () => {
    const msg = formatter.format(makeAnomaly({ severity: 'HIGH' }), makeTrade());
    expect(msg.text).toContain('🚨');
  });

  it('uses 🚨 for CRITICAL severity', () => {
    const msg = formatter.format(makeAnomaly({ severity: 'CRITICAL' }), makeTrade());
    expect(msg.text).toContain('🚨');
  });

  it('uses ⚠️ for MEDIUM severity', () => {
    const msg = formatter.format(makeAnomaly({ severity: 'MEDIUM' }), makeTrade());
    expect(msg.text).toContain('⚠️');
  });

  it('uses ℹ️ for LOW severity', () => {
    const msg = formatter.format(makeAnomaly({ severity: 'LOW' }), makeTrade());
    expect(msg.text).toContain('ℹ️');
  });

  it('cluster alert uses 🚨 for CRITICAL severity', () => {
    const msg = formatter.formatClusterMessage(makeClusterAnomaly({ severity: 'CRITICAL' }));
    expect(msg.text).toContain('🚨');
  });

  it('cluster alert uses ⚠️ for MEDIUM severity', () => {
    const msg = formatter.formatClusterMessage(makeClusterAnomaly({ severity: 'MEDIUM' }));
    expect(msg.text).toContain('⚠️');
  });
});

// ─── PolygonScan URL generation ───────────────────────────────────────────────

describe('PolygonScan URL generation (Req 10.5)', () => {
  it('includes polygonscan.com/address link for wallet address', () => {
    const trade = makeTrade({ walletAddress: '0xaAbBcCdDeEfF0011223344556677889900aAbBcC' });
    const msg = formatter.format(makeAnomaly(), trade);
    expect(msg.text).toContain('https://polygonscan.com/address/0xaAbBcCdDeEfF0011223344556677889900aAbBcC');
  });

  it('cluster alert includes polygonscan links for each wallet', () => {
    const wallets = [
      '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
    ];
    const msg = formatter.formatClusterMessage(makeClusterAnomaly({ wallets }));
    for (const wallet of wallets) {
      expect(msg.text).toContain(`https://polygonscan.com/address/${wallet}`);
    }
  });
});

// ─── Polymarket URL generation ────────────────────────────────────────────────

describe('Polymarket URL generation (Req 10.6)', () => {
  it('includes polymarket.com/event link for market', () => {
    const trade = makeTrade({ marketId: 'market-abc', marketName: 'Will BTC hit 100k?' });
    const msg = formatter.format(makeAnomaly(), trade);
    expect(msg.text).toContain('https://polymarket.com/event/market-abc');
  });

  it('cluster alert includes polymarket link for market', () => {
    const anomaly = makeClusterAnomaly({ marketId: 'cluster-market-1', marketName: 'Test Market' });
    const msg = formatter.formatClusterMessage(anomaly);
    expect(msg.text).toContain('https://polymarket.com/event/cluster-market-1');
  });
});

// ─── CRITICAL cluster alert includes funder address and funded wallet links ───

describe('CRITICAL cluster alert includes funder address and funded wallet links (Req 10.5, 10.6)', () => {
  const funderAddress = '0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF';
  const wallets = [
    '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
  ];

  it('includes funder address polygonscan link in CRITICAL cluster alert', () => {
    const anomaly = makeClusterAnomaly({
      severity: 'CRITICAL',
      wallets,
      fundingAnalysis: makeCommonFunderAnalysis(wallets, funderAddress),
    });
    const msg = formatter.formatClusterMessage(anomaly);
    expect(msg.text).toContain(`https://polygonscan.com/address/${funderAddress}`);
  });

  it('includes all funded wallet polygonscan links in CRITICAL cluster alert', () => {
    const anomaly = makeClusterAnomaly({
      severity: 'CRITICAL',
      wallets,
      fundingAnalysis: makeCommonFunderAnalysis(wallets, funderAddress),
    });
    const msg = formatter.formatClusterMessage(anomaly);
    for (const wallet of wallets) {
      expect(msg.text).toContain(`https://polygonscan.com/address/${wallet}`);
    }
  });

  it('CRITICAL alert text contains "Common Funder" section', () => {
    const anomaly = makeClusterAnomaly({
      severity: 'CRITICAL',
      wallets,
      fundingAnalysis: makeCommonFunderAnalysis(wallets, funderAddress),
    });
    const msg = formatter.formatClusterMessage(anomaly);
    expect(msg.text).toContain('Common Funder');
  });

  it('non-CRITICAL cluster alert does NOT include funder section', () => {
    const anomaly = makeClusterAnomaly({
      severity: 'HIGH',
      wallets,
      fundingAnalysis: makeNoFundingAnalysis(wallets),
    });
    const msg = formatter.formatClusterMessage(anomaly);
    expect(msg.text).not.toContain('Common Funder');
  });
});

// ─── Message length <= 4096 chars ────────────────────────────────────────────

describe('Message length <= 4096 chars for all anomaly types (Req 10.7)', () => {
  it('RAPID_ODDS_SHIFT message length is <= 4096', () => {
    const msg = formatter.format(
      makeAnomaly({ type: 'RAPID_ODDS_SHIFT' }),
      makeTrade(),
    );
    expect(msg.text.length).toBeLessThanOrEqual(4096);
  });

  it('WHALE_ACTIVITY message length is <= 4096', () => {
    const msg = formatter.format(
      makeAnomaly({
        type: 'WHALE_ACTIVITY',
        details: { description: 'Whale', metrics: { zScore: 5.1, liquidityConsumedPercent: 35.5 } },
      }),
      makeTrade(),
    );
    expect(msg.text.length).toBeLessThanOrEqual(4096);
  });

  it('INSIDER_TRADING message length is <= 4096', () => {
    const msg = formatter.format(
      makeAnomaly({
        type: 'INSIDER_TRADING',
        details: { description: 'Insider', metrics: { walletAgeHours: 2.5, transactionCount: 3, riskScore: 85 } },
      }),
      makeTrade(),
    );
    expect(msg.text.length).toBeLessThanOrEqual(4096);
  });

  it('cluster alert message length is <= 4096', () => {
    const msg = formatter.formatClusterMessage(makeClusterAnomaly());
    expect(msg.text.length).toBeLessThanOrEqual(4096);
  });

  it('CRITICAL cluster alert with many wallets is <= 4096', () => {
    const wallets = Array.from({ length: 50 }, (_, i) =>
      `0x${i.toString(16).padStart(40, '0')}`,
    );
    const funder = '0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF';
    const anomaly = makeClusterAnomaly({
      severity: 'CRITICAL',
      wallets,
      fundingAnalysis: makeCommonFunderAnalysis(wallets, funder),
    });
    const msg = formatter.formatClusterMessage(anomaly);
    expect(msg.text.length).toBeLessThanOrEqual(4096);
  });

  it('message with very long market name is truncated to <= 4096', () => {
    const longName = 'A'.repeat(4000);
    const msg = formatter.format(makeAnomaly(), makeTrade({ marketName: longName }));
    expect(msg.text.length).toBeLessThanOrEqual(4096);
  });
});

// ─── Markdown escaping of special characters ─────────────────────────────────

describe('Markdown escaping of special characters in market names (Req 10.1)', () => {
  it('escapes underscores in market name', () => {
    const msg = formatter.format(makeAnomaly(), makeTrade({ marketName: 'BTC_ETH_Market' }));
    expect(msg.text).toContain('BTC\\_ETH\\_Market');
  });

  it('escapes asterisks in market name', () => {
    const msg = formatter.format(makeAnomaly(), makeTrade({ marketName: 'BTC*ETH' }));
    expect(msg.text).toContain('BTC\\*ETH');
  });

  it('escapes square brackets in market name', () => {
    const msg = formatter.format(makeAnomaly(), makeTrade({ marketName: 'Market [2024]' }));
    expect(msg.text).toContain('Market \\[2024\\]');
  });

  it('escapes parentheses in market name', () => {
    const msg = formatter.format(makeAnomaly(), makeTrade({ marketName: 'Market (Q1)' }));
    expect(msg.text).toContain('Market \\(Q1\\)');
  });

  it('escapes dots in market name', () => {
    const msg = formatter.format(makeAnomaly(), makeTrade({ marketName: 'v1.2.3 release' }));
    expect(msg.text).toContain('v1\\.2\\.3 release');
  });

  it('plain market name without special chars is not altered', () => {
    const msg = formatter.format(makeAnomaly(), makeTrade({ marketName: 'Simple Market Name' }));
    expect(msg.text).toContain('Simple Market Name');
  });
});

// ─── parse_mode and disable_web_page_preview ─────────────────────────────────

describe('TelegramMessage metadata (Req 10.1)', () => {
  it('format() returns parse_mode Markdown', () => {
    const msg = formatter.format(makeAnomaly(), makeTrade());
    expect(msg.parse_mode).toBe('Markdown');
  });

  it('formatClusterMessage() returns parse_mode Markdown', () => {
    const msg = formatter.formatClusterMessage(makeClusterAnomaly());
    expect(msg.parse_mode).toBe('Markdown');
  });

  it('format() sets disable_web_page_preview to false', () => {
    const msg = formatter.format(makeAnomaly(), makeTrade());
    expect(msg.disable_web_page_preview).toBe(false);
  });
});
