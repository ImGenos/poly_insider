import { Logger } from './Logger';

const FALLBACK_RATE = 0.92; // taux de secours USD → EUR
const CACHE_TTL_MS = 60 * 60 * 1000; // rafraîchissement toutes les heures
const API_URL = 'https://open.er-api.com/v6/latest/USD';

interface ExchangeRateResponse {
  result: string;
  rates: Record<string, number>;
}

export class ExchangeRateService {
  private static instance: ExchangeRateService;

  private rate: number = FALLBACK_RATE;
  private lastFetchedAt: number = 0;
  private fetchPromise: Promise<void> | null = null;
  private readonly logger: Logger;

  private constructor(logger?: Logger) {
    this.logger = logger ?? new Logger('info', undefined);
  }

  static getInstance(logger?: Logger): ExchangeRateService {
    if (!ExchangeRateService.instance) {
      ExchangeRateService.instance = new ExchangeRateService(logger);
    }
    return ExchangeRateService.instance;
  }

  /** Retourne le taux USD → EUR, en rafraîchissant si le cache est expiré. */
  async getUsdToEurRate(): Promise<number> {
    const now = Date.now();
    if (now - this.lastFetchedAt < CACHE_TTL_MS) {
      return this.rate;
    }

    // Évite les appels concurrents
    if (!this.fetchPromise) {
      this.fetchPromise = this.fetchRate().finally(() => {
        this.fetchPromise = null;
      });
    }

    await this.fetchPromise;
    return this.rate;
  }

  /** Taux actuel en cache (synchrone, sans attente réseau). */
  getCachedRate(): number {
    return this.rate;
  }

  private async fetchRate(): Promise<void> {
    try {
      const res = await fetch(API_URL, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = (await res.json()) as ExchangeRateResponse;
      if (data.result !== 'success' || !data.rates?.EUR) {
        throw new Error('Réponse invalide de l\'API de taux de change');
      }

      this.rate = data.rates.EUR;
      this.lastFetchedAt = Date.now();
      this.logger.info(`Taux USD→EUR mis à jour : ${this.rate.toFixed(4)}`);
    } catch (err) {
      this.logger.warn(
        `Impossible de récupérer le taux USD→EUR (${(err as Error).message}). ` +
        `Taux de secours utilisé : ${FALLBACK_RATE}`
      );
      // On garde le dernier taux connu (ou le fallback si premier appel)
      if (this.lastFetchedAt === 0) {
        this.rate = FALLBACK_RATE;
      }
    }
  }
}
