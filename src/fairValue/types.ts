export type OptionSide = "CE" | "PE";
export type Quality = "supported" | "limited" | "research" | "invalid" | "unavailable";
export interface Diagnostic { code: string; severity: "info" | "warning" | "error"; message: string; strike?: number; k?: number; value?: number }
export interface IvResult { status: string; iv: number | null; iterations: number; residual: number | null; vega: number | null; reason: string }
export interface Greeks { forward_delta: number; forward_gamma: number | null; vega_1pct: number; spot_delta: number | null; spot_gamma: number | null; theta_calendar_day: number | null; rho_1pct: number; convention: string }
export interface Quote { mid: number; spread: number; relative_spread: number; age_ms: number; freshness_basis: string; available_depth: number; weight: number; h: number; exchange_timestamp: string | null; receive_timestamp: string; calibration_eligible: boolean; reasons: string[] }
export interface Comparison { mid_deviation: number; mid_deviation_percent: number; label: string; theoretical_buy_difference: number; theoretical_sell_difference: number; lot_mid_deviation: number; lot_buy_difference: number; lot_sell_difference: number; convention: string }
export interface Row {
  token: number; tradingsymbol: string; strike: number; side: OptionSide; lot_size: number | null;
  metadata: { expiry_timestamp: string; expiry_source: string; settlement_underlying: string; tick_size: number; style: string } | null;
  bid: number | null; ask: number | null; mid: number | null; quote: Quote | null;
  observed_iv: IvResult | null; bid_iv: IvResult | null; ask_iv: IvResult | null;
  surface_iv: number | null; total_variance: number | null; fair_value: number | null; fair_value_per_lot: number | null;
  independent_value: number | null; independent_status: string; comparison: Comparison | null;
  greeks: Greeks | null; quality: Quality; reasons: string[]; estimation_method: string;
  expiry_payoff: { value: number | null; value_per_lot: number | null; status: string; reason: string } | null;
  sensitivity: Sensitivity | null;
}
export interface Forward {
  available: boolean; value: number | null; source: string; pair_count: number; dispersion: number | null;
  interval: { lower: number; upper: number; compatible: boolean } | null;
  excluded_pairs: { strike: number; reasons: string[] }[];
  pairs: { strike: number; forward: number; lower: number; upper: number; residual: number; scale: number; weight: number }[];
  assumptions: string[]; diagnostics: Diagnostic[];
}
export interface Smile {
  method: string; parameters: { a: number; b: number; rho: number; m: number; eta: number } | null;
  nodes: { k: number; w: number }[]; support: { min_k: number; max_k: number; strikes: number[] } | null;
  valid: boolean; diagnostics: Diagnostic[];
  butterfly: { min_g: number | null; checked_points: number; domain: [number, number] | null; right_wing_slope: number | null; left_wing_slope: number | null; tail_condition: boolean | null; global_proof: false };
  calibration: { observation_count: number; distinct_strikes: number; normalized_rmse: number | null;
    inside_spread_percent: number | null; optimizer_status: string; optimizer_iterations: number;
    optimizer_starts: number; duration_ms: number; rejected: { token: number; reason: string }[];
    residuals: { token: number; strike: number; side: string; model_price: number; residual: number; standardized_residual: number; inside_spread: boolean }[] };
}
export interface Discount { available: boolean; d: number | null; zero_rate: number | null; method: string; assumption: string | null; reason: string | null; provenance: { source: string; as_of: string; version: string; convention: string } }
export interface Slice {
  expiry: string; expiry_timestamp: string | null; t: number | null; discount: Discount | null;
  forward: Forward; smile: Smile; rows: Row[]; snapshot_dispersion_ms: number; atm_iv: number | null;
  quality: Quality; reasons: string[]; diagnostics: Diagnostic[];
  observations: { k: number; w: number; iv: number; strike: number; side: string; token: number }[];
}
export interface Snapshot {
  id: string; input_snapshot_id: string; model_version: string; config_version: string; sequence: number;
  underlying: string; name: string; broker: string; broker_generation: number; feed_generation: number;
  valuation_time: string; published_at: string; timezone: string; day_count: string; premium_unit: string;
  slices: Slice[]; calendar_regions: { first_expiry: string; second_expiry: string; min_k: number; max_k: number; valid: boolean; diagnostics: Diagnostic[] }[];
  spot: { value: number; timestamp: string } | null; curve: Record<string, unknown>; carry: Record<string, unknown> | null;
  universe: { listed_contracts: number; captured_contracts: number; omitted_expiries: string[]; bounded: boolean };
  diagnostics: Diagnostic[]; duration_ms: number;
}
export interface Status {
  enabled: boolean; paused: boolean; model_version: string; config_version: string; config_persisted: boolean;
  expiry_policy_configured: boolean; curve_configured: boolean; broker: string; broker_generation: number;
  feed_generation: number; data_ready: boolean; subscribed_tokens: number; watched_underlyings: string[];
  surface_max_age_ms: number;
  workers: { running: number; queued: number; failures: number; workers: number };
  last_error: string | null; storage: string; persistence_error: string | null;
  feed: { connected?: boolean; lastTickAgeMs?: number | null };
  surfaces: { underlying: string; id: string; sequence: number; age_ms: number; valid_expiries: number }[];
}
export interface SnapshotResponse { snapshot: Snapshot | null; surface_age_ms: number | null; stale: boolean; status: Status }
export interface HistorySummary { id: string; input_snapshot_id: string; model_version: string; config_version: string; published_at: string; valuation_time: string; underlying: string }
export interface ConfigResponse { config: { enabled: boolean; research_enabled: boolean; refresh_ms: number; [key: string]: unknown }; version: string; persisted: boolean }
export interface Sensitivity { label: "Model sensitivity range"; low: number; high: number; scenarios: { name: string; forward: number; discount: number; iv: number; price: number; assumption: string }[]; reasons: string[] }
export interface CalculatorResult {
  available: boolean; input_snapshot_id: string; config_version: string; contract: "listed" | "hypothetical";
  model_version: string; valuation_time: string;
  instrument_token: number | null; strike_method: string; maturity_method: string; strike: number; expiry_timestamp: string;
  side: OptionSide; t: number; forward: number | null; discount: number | null; k: number | null;
  total_variance: number | null; surface_iv: number | null; fair_value: number | null; fair_value_per_lot: number | null;
  lot_size: number | null; greeks: Greeks | null; quality: Quality; reasons: string[]; assumptions: string[];
  diagnostics: Diagnostic[]; sensitivity: Sensitivity | null;
}
export interface Independent {
  status: string; input_snapshot_id: string; config_version: string; expiry: string; strike: number;
  values: { side: OptionSide; fair_value: number; per_lot: number | null }[]; forward: Forward; smile: Smile;
  excluded_tokens: number[]; duration_ms: number; reasons: string[];
}
