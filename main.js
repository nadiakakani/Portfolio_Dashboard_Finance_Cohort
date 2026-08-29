// GenAI Finance Dashboard - Prompt 2
const CONFIG = {
  benchmark: "SPY",              // fetched once, shared: relative strength + regime overlay

  universe: {
    steady:    { label: "Steady Compounders", tickers: ["MSFT","AAPL","V","JPM","BRK.B"],
                 purpose: "Durable businesses with persistent trends and controlled risk." },
    growth:    { label: "High Growth",        tickers: ["NVDA","AMD","AMZN","GOOGL","PLTR"],
                 purpose: "Higher growth and stronger momentum while controlling volatility." },
    cyclical:  { label: "Cyclical",           tickers: ["CAT","XOM","CVX","FCX","BAC"],
                 purpose: "Industrial, commodity, rate and economic-cycle movements." },
    defensive: { label: "Defensive / Income", tickers: ["KO","WMT","JNJ","ABBV","NEE"],
                 purpose: "Relative stability within an all-equity portfolio." }
  },

  // Five-component score weights, per bucket. Each column must total 100%.
  scoreWeights: {
    steady:    { trend: 0.30, momentum: 0.15, risk: 0.30, volume: 0.10, sentiment: 0.15 },
    growth:    { trend: 0.30, momentum: 0.30, risk: 0.10, volume: 0.15, sentiment: 0.15 },
    cyclical:  { trend: 0.25, momentum: 0.25, risk: 0.15, volume: 0.20, sentiment: 0.15 },
    defensive: { trend: 0.25, momentum: 0.10, risk: 0.40, volume: 0.10, sentiment: 0.15 }
  },

  qualityGate: { steady: 55, growth: 35, cyclical: 40, defensive: 60 },
  qualityWeights: { revenueGrowth: 0.40, roe: 0.35, debtEquity: 0.25 },

  qualificationThreshold: 50,     // final score below this does not qualify
  weightingMethod: "inverseVolatility",  // | "scoreProportional" | "equalWeight"

  maxWeightPerStock: 0.10,
  maxWeightInBucket: 0.35,
  minMeaningfulPosition: 0.02,
  rebalanceTolerancePct: 0.005,   // ignore trades smaller than 0.5% of the portfolio

  liquidityTiers: [
    { name: "Very liquid", minAdtvUsd: 100_000_000, participationCeiling: 0.05, treatment: "normal"         },
    { name: "Liquid",      minAdtvUsd:  20_000_000, participationCeiling: 0.03, treatment: "normal"         },
    { name: "Moderate",    minAdtvUsd:   5_000_000, participationCeiling: 0.01, treatment: "size-restricted"},
    { name: "Low",         minAdtvUsd:   1_000_000, participationCeiling: 0.005,treatment: "manual-review"  },
    { name: "Illiquid",    minAdtvUsd:           0, participationCeiling: 0,    treatment: "reject"         }
  ],
  volumeLookbackDays: 20,

  cost: {
    impactCoefficient: 1.0,       // Y — UNCALIBRATED, must be labelled as such everywhere
    assumedHalfSpreadPct: { "Very liquid": 0.0002, "Liquid": 0.0005,
                            "Moderate": 0.0015, "Low": 0.0040, "Illiquid": 0.0100 },
    maxTotalCostPct: 0.015
  },

  sentimentFactors: {
    minConfidenceFloor: 0.60,
    recencyFullDays: 3, recencyZeroDays: 30, recencyFloor: 0.70,
    sourceQuality: { 1: 0.85, 2: 0.92, 3: 1.00 }   // by count of distinct sources
  },

  confidenceBands: { high: 80, medium: 60, low: 40 },

  regimeOverlay: { enabled: false, cap: 0.10 },    // optional, Prompt 15

  indicators: { rsiPeriod: 14, macdFast: 12, macdSlow: 26, macdSignal: 9,
                smaFast: 50, smaSlow: 200, volLookback: 60, drawdownLookback: 252,
                obvLookback: 20, relativeStrengthDays: 63 },

  providers: { price: "twelvedata", fundamentals: "fmp",
               news: "finnhub", llmModel: "google/gemini-2.0-flash-001" },

  throttleMsBetweenCalls: 8000,
  cacheHours: 12,
  disclaimer: "Educational MBA prototype. Not personalised investment advice. Proposes only — never trades."
};

function assertScoreWeights() {
  const buckets = Object.keys(CONFIG.scoreWeights);
  for (const bucket of buckets) {
    const weights = CONFIG.scoreWeights[bucket];
    const sum = weights.trend + weights.momentum + weights.risk + weights.volume + weights.sentiment;
    if (Math.abs(sum - 1.0) > 1e-5) {
      console.error(`CRITICAL: scoreWeights for bucket '${bucket}' sum to ${sum.toFixed(4)}, not 1.00!`);
    }
  }
}

// Call on startup
assertScoreWeights();

// Consolidated state object (Part A section A7)
let portfolioState = {
  inputs: {
    totalInvestment: 500000,
    currency: "USD",
    existingHoldings: [],
    cashReservePct: 5,
    commissionPct: 0.1,
    taxPct: 0.5,
    fractionalShares: false,
    maxExecutionDays: 5,
    riskFactor: 0.5,
    weightingMethod: "inverseVolatility"
  },
  capital: {
    gross: 0,
    existingValue: 0,
    cashReserve: 0,
    provisionalFeeReserve: 0,
    investable: 0,
    targetPortfolioValue: 0,
    deployed: 0,
    undeployed: 0,
    estimatedActualCost: 0,
    feeReserveVariance: 0,
    grossPurchases: 0,
    grossSales: 0,
    netCashRequirement: 0
  },
  benchmark: { ticker: "SPY", price: 0, sma200: 0, return63d: 0, aboveSma200: false },
  buckets: {
    steady:    { strategicWeight: 0, regimeAdjustment: 0, finalWeight: 0, amount: 0, qualifiers: [], deployed: 0, undeployed: 0, purpose: CONFIG.universe.steady.purpose },
    growth:    { strategicWeight: 0, regimeAdjustment: 0, finalWeight: 0, amount: 0, qualifiers: [], deployed: 0, undeployed: 0, purpose: CONFIG.universe.growth.purpose },
    cyclical:  { strategicWeight: 0, regimeAdjustment: 0, finalWeight: 0, amount: 0, qualifiers: [], deployed: 0, undeployed: 0, purpose: CONFIG.universe.cyclical.purpose },
    defensive: { strategicWeight: 0, regimeAdjustment: 0, finalWeight: 0, amount: 0, qualifiers: [], deployed: 0, undeployed: 0, purpose: CONFIG.universe.defensive.purpose }
  },
  stocks: [],
  correlationMatrix: [],
  comparison: {
    inverseVolatility: { vol: 0, concentration: 0 },
    scoreProportional: { vol: 0, concentration: 0 },
    equalWeight: { vol: 0, concentration: 0 }
  },
  hardBlocks: [],
  warnings: [],
  manualExclusions: [],
  executiveSummary: { thesis: "", supportingSignals: [], riskFactors: [], recommendation: "", dataQualityNote: "" },
  calculatedAtUtc: ""
};

let activePreset = null; // null or "balanced"

// Currency formatting helper
function formatCurrency(amount, currency = "USD") {
  const symbols = { USD: "$", GBP: "£", EUR: "€" };
  const sym = symbols[currency] || "$";
  return sym + Number(amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Calculate capital per A6.1
function calculateCapital() {
  const totalInvestment = Number(document.getElementById('total-investment')?.value || 500000);
  const baseCurrency = document.getElementById('base-currency')?.value || "USD";
  const cashReservePct = Number(document.getElementById('cash-reserve')?.value || 5) / 100;
  const commissionPct = Number(document.getElementById('commission-pct')?.value || 0.1) / 100;
  const taxPct = Number(document.getElementById('tax-pct')?.value || 0.5) / 100;

  const feesPct = commissionPct + taxPct;
  const provisionalReserve = feesPct * totalInvestment;
  const cashReserve = cashReservePct * totalInvestment;
  const investableCapital = totalInvestment - cashReserve - provisionalReserve;

  // Existing holdings market value (0 until prices fetched in later prompts)
  const existingHoldingsValue = 0; 
  const targetPortfolioValue = existingHoldingsValue + Math.max(0, investableCapital);

  portfolioState.inputs.totalInvestment = totalInvestment;
  portfolioState.inputs.currency = baseCurrency;
  portfolioState.inputs.cashReservePct = cashReservePct * 100;
  portfolioState.inputs.commissionPct = commissionPct * 100;
  portfolioState.inputs.taxPct = taxPct * 100;

  portfolioState.capital.gross = totalInvestment;
  portfolioState.capital.existingValue = existingHoldingsValue;
  portfolioState.capital.cashReserve = cashReserve;
  portfolioState.capital.provisionalFeeReserve = provisionalReserve;
  portfolioState.capital.investable = Math.max(0, investableCapital);
  portfolioState.capital.targetPortfolioValue = targetPortfolioValue;

  return portfolioState.capital;
}

// Calculate bucket weights per A6.2
function calculateBucketWeights(R) {
  let weights;
  let modeLabel = `Formula-Derived from R=${R.toFixed(2)}`;

  if (activePreset === 'balanced') {
    weights = { steady: 0.35, growth: 0.25, cyclical: 0.20, defensive: 0.20 };
    modeLabel = "Balanced Preset (35/25/20/20) — preset, not formula-derived";
  } else {
    const steady    = 0.35 - 0.10 * R;
    const growth    = 0.10 + 0.35 * R;
    const cyclical  = 0.10 + 0.10 * R;
    const defensive = 0.45 - 0.35 * R;
    weights = { steady, growth, cyclical, defensive };
  }

  // Assert sum is 1.00
  const sum = weights.steady + weights.growth + weights.cyclical + weights.defensive;
  const errBanner = document.getElementById('weight-error-banner');
  if (Math.abs(sum - 1.0) > 1e-5) {
    console.error("Bucket weights sum error:", sum);
    if (errBanner) {
      errBanner.style.display = 'block';
      errBanner.textContent = `CRITICAL INVARIANT ERROR: Bucket weights sum to ${(sum*100).toFixed(2)}%, not 100%!`;
    }
  } else {
    if (errBanner) errBanner.style.display = 'none';
  }

  const modeEl = document.getElementById('weight-mode-label');
  if (modeEl) modeEl.textContent = modeLabel;

  return weights;
}

// Update and render dashboard state for Prompt 2
function updateDashboardState() {
  const cap = calculateCapital();
  const riskSlider = document.getElementById('risk-factor');
  const R = riskSlider ? Number(riskSlider.value) : 0.5;
  portfolioState.inputs.riskFactor = R;

  const weights = calculateBucketWeights(R);
  const currency = portfolioState.inputs.currency;

  // Update bucket amounts and weights in state
  const targetVal = cap.targetPortfolioValue;
  for (const key of ['steady', 'growth', 'cyclical', 'defensive']) {
    portfolioState.buckets[key].finalWeight = weights[key];
    portfolioState.buckets[key].amount = targetVal * weights[key];
  }

  // Render Waterfall
  document.getElementById('wf-gross').textContent = formatCurrency(cap.gross, currency);
  document.getElementById('wf-existing').textContent = formatCurrency(cap.existingValue, currency);
  document.getElementById('wf-reserve').textContent = formatCurrency(cap.cashReserve, currency);
  document.getElementById('wf-fees').textContent = formatCurrency(cap.provisionalFeeReserve, currency);
  document.getElementById('wf-investable').textContent = formatCurrency(cap.investable, currency);
  document.getElementById('wf-existing-add').textContent = formatCurrency(cap.existingValue, currency);
  document.getElementById('wf-target').textContent = formatCurrency(targetVal, currency);

  // Render Stacked Bar & Breakdown List
  const barEl = document.getElementById('bucket-stacked-bar');
  const listEl = document.getElementById('bucket-breakdown-list');

  const bucketMeta = [
    { key: 'steady', label: CONFIG.universe.steady.label, color: '#14213d' },
    { key: 'growth', label: CONFIG.universe.growth.label, color: '#9a6b2c' },
    { key: 'cyclical', label: CONFIG.universe.cyclical.label, color: '#3f51b5' },
    { key: 'defensive', label: CONFIG.universe.defensive.label, color: '#2e7d32' }
  ];

  if (barEl) {
    let barHtml = '';
    bucketMeta.forEach(b => {
      const pct = (weights[b.key] * 100).toFixed(1);
      barHtml += `<div title="${b.label}: ${pct}%" style="width: ${pct}%; background: ${b.color}; height: 100%; display: flex; align-items: center; justify-content: center; color: white; font-size: 0.75rem; font-weight: bold; overflow: hidden; white-space: nowrap;">${pct > 8 ? pct + '%' : ''}</div>`;
    });
    barEl.innerHTML = barHtml;
  }

  if (listEl) {
    let listHtml = '<div style="display: grid; gap: 0.5rem;">';
    bucketMeta.forEach(b => {
      const wt = weights[b.key];
      const amt = portfolioState.buckets[b.key].amount;
      const purpose = portfolioState.buckets[b.key].purpose;
      listHtml += `
        <div style="display: flex; justify-content: space-between; align-items: center; background: #f4f3ef; padding: 0.5rem 0.75rem; border-radius: 3px;">
          <div style="display: flex; align-items: center; gap: 0.5rem;">
            <div style="width: 12px; height: 12px; background: ${b.color}; border-radius: 2px;"></div>
            <div>
              <strong>${b.label}</strong> <span style="font-size: 0.8rem; color: #666; font-style: italic;">(${purpose})</span>
            </div>
          </div>
          <div style="text-align: right; font-family: monospace;">
            <strong>${(wt * 100).toFixed(1)}%</strong> <span style="color: #555; margin-left: 0.5rem;">(${formatCurrency(amt, currency)})</span>
          </div>
        </div>
      `;
    });
    listHtml += '</div>';
    listEl.innerHTML = listHtml;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  // Render disclaimer
  const footer = document.getElementById('app-footer');
  if (footer) {
    footer.innerHTML = `<p>${CONFIG.disclaimer}</p>`;
  }

  // Risk slider interaction
  const riskSlider = document.getElementById('risk-factor');
  const riskValueSpan = document.getElementById('risk-value');
  const riskLabelSpan = document.getElementById('risk-label');
  const presetStatus = document.getElementById('preset-status');

  function updateRiskDisplay(val) {
    riskValueSpan.textContent = val;
    let label = 'Balanced';
    if (val < 0.35) label = 'Conservative';
    else if (val > 0.65) label = 'Aggressive';
    riskLabelSpan.textContent = label;
  }

  if (riskSlider) {
    riskSlider.addEventListener('input', (e) => {
      if (activePreset) {
        activePreset = null; // Dragging slider exits preset mode
        if (presetStatus) presetStatus.style.display = 'none';
      }
      updateRiskDisplay(e.target.value);
      updateDashboardState();
    });
    updateRiskDisplay(riskSlider.value);
  }

  // Balanced Preset button
  const balancedPresetBtn = document.getElementById('balanced-preset-btn');
  if (balancedPresetBtn) {
    balancedPresetBtn.addEventListener('click', () => {
      activePreset = 'balanced';
      if (presetStatus) presetStatus.style.display = 'block';
      updateDashboardState();
    });
  }

  // Mandate form inputs live listeners
  const mandateInputs = ['total-investment', 'base-currency', 'cash-reserve', 'commission-pct', 'tax-pct'];
  mandateInputs.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('input', updateDashboardState);
      el.addEventListener('change', updateDashboardState);
    }
  });

  // API Keys initialization with 3-step chain
  const keysConfig = [
    { id: 'twelvedata-key', noteId: 'twelvedata-note', envNames: ['VITE_TWELVEDATA_API_KEY', 'VITE_TWELVEDATA_KEY'], storageKey: 'twelvedata_key' },
    { id: 'fmp-key', noteId: 'fmp-note', envNames: ['VITE_FMP_API_KEY', 'VITE_FMP_KEY'], storageKey: 'fmp_key' },
    { id: 'finnhub-key', noteId: 'finnhub-note', envNames: ['VITE_FINNHUB_API_KEY', 'VITE_FINNHUB_KEY'], storageKey: 'finnhub_key' },
    { id: 'openrouter-key', noteId: 'openrouter-note', envNames: ['VITE_OPENROUTER_API_KEY', 'VITE_OPENROUTER_KEY'], storageKey: 'openrouter_key' }
  ];

  keysConfig.forEach(cfg => {
    const input = document.getElementById(cfg.id);
    const note = document.getElementById(cfg.noteId);
    if (!input) return;

    let envVal = '';
    for (const name of cfg.envNames) {
      if (import.meta.env[name]) {
        envVal = import.meta.env[name];
        break;
      }
    }

    const storedVal = localStorage.getItem(cfg.storageKey);

    if (envVal) {
      input.value = envVal;
      if (note) note.style.display = 'inline';
    } else if (storedVal) {
      input.value = storedVal;
    }

    input.addEventListener('input', () => {
      const val = input.value.trim();
      localStorage.setItem(cfg.storageKey, val);
      if (envVal && val === envVal) {
        if (note) note.style.display = 'inline';
      } else {
        if (note) note.style.display = 'none';
      }
    });
  });

  // Clear keys button
  const clearKeysBtn = document.getElementById('clear-keys-btn');
  if (clearKeysBtn) {
    clearKeysBtn.addEventListener('click', () => {
      keysConfig.forEach(cfg => {
        localStorage.removeItem(cfg.storageKey);
        const input = document.getElementById(cfg.id);
        const note = document.getElementById(cfg.noteId);
        let envVal = '';
        for (const name of cfg.envNames) {
          if (import.meta.env[name]) {
            envVal = import.meta.env[name];
            break;
          }
        }
        if (input) input.value = envVal;
        if (note) note.style.display = envVal ? 'inline' : 'none';
      });
      alert('Saved API keys cleared from browser storage.');
    });
  }

  // Existing holdings logic
  const addHoldingBtn = document.getElementById('add-holding-btn');
  const holdingTickerInput = document.getElementById('new-holding-ticker');
  const holdingSharesInput = document.getElementById('new-holding-shares');
  const holdingsListEl = document.getElementById('holdings-list');

  function renderHoldings() {
    if (!holdingsListEl) return;
    if (portfolioState.inputs.existingHoldings.length === 0) {
      holdingsListEl.innerHTML = '<p class="placeholder">No existing holdings added.</p>';
      return;
    }
    let html = '<ul style="list-style: none; padding: 0; margin: 0.5rem 0 0; display: grid; gap: 0.5rem;">';
    portfolioState.inputs.existingHoldings.forEach((h, index) => {
      html += `
        <li style="display: flex; justify-content: space-between; align-items: center; background: #f4f3ef; padding: 0.4rem 0.75rem; border-radius: 3px; font-family: monospace; font-size: 0.9rem;">
          <span><strong>${h.ticker}</strong>: ${h.shares.toLocaleString()} shares</span>
          <button type="button" class="remove-holding-btn" data-index="${index}" style="background: var(--error); margin: 0; padding: 0.2rem 0.5rem; font-size: 0.8rem;">Remove</button>
        </li>
      `;
    });
    html += '</ul>';
    holdingsListEl.innerHTML = html;

    holdingsListEl.querySelectorAll('.remove-holding-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const idx = Number(e.target.getAttribute('data-index'));
        portfolioState.inputs.existingHoldings.splice(idx, 1);
        renderHoldings();
        updateDashboardState();
      });
    });
  }

  if (addHoldingBtn) {
    addHoldingBtn.addEventListener('click', () => {
      const ticker = holdingTickerInput.value.trim().toUpperCase();
      const shares = Number(holdingSharesInput.value);
      if (!ticker) {
        alert('Please enter a ticker symbol.');
        return;
      }
      if (isNaN(shares) || shares <= 0) {
        alert('Please enter a valid positive share count.');
        return;
      }
      portfolioState.inputs.existingHoldings.push({ ticker, shares });
      holdingTickerInput.value = '';
      holdingSharesInput.value = '';
      renderHoldings();
      updateDashboardState();
    });
  }

  // Run analysis button execution queue for Prompt 3
  const runBtn = document.getElementById('run-analysis-btn');
  const progressEl = document.getElementById('analysis-progress');
  const forceRefreshCb = document.getElementById('force-refresh-checkbox');
  const stocksDataListEl = document.getElementById('stocks-data-list');

  // Helper: sleep
  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  /**
   * fetchDailyPrices(ticker, apiKey) against Twelve Data
   * Endpoint: https://api.twelvedata.com/time_series
   * Parameters: symbol=<ticker>&interval=1day&outputsize=250&apikey=<apiKey>
   * Expected response fields:
   * {
   *   "meta": { "symbol": "...", "interval": "1day", ... },
   *   "values": [
   *     { "datetime": "YYYY-MM-DD", "open": "...", "high": "...", "low": "...", "close": "...", "volume": "..." },
   *     ...
   *   ],
   *   "status": "ok"
   * }
   */
  async function fetchDailyPrices(ticker, apiKey, forceRefresh = false) {
    const cacheKey = `twelvedata_ts_${ticker}`;
    const cachedRaw = localStorage.getItem(cacheKey);
    const now = Date.now();

    if (!forceRefresh && cachedRaw) {
      try {
        const cached = JSON.parse(cachedRaw);
        const ageHours = (now - cached.timestamp) / (1000 * 60 * 60);
        if (ageHours < CONFIG.cacheHours && cached.values && cached.values.length > 0) {
          return cached.values;
        }
      } catch (e) {
        console.warn("Cache parse error for", ticker, e);
      }
    }

    if (!apiKey) {
      throw new Error("Missing Twelve Data API key.");
    }

    const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(ticker)}&interval=1day&outputsize=250&apikey=${encodeURIComponent(apiKey)}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    if (data.status && data.status !== 'ok') {
      throw new Error(data.message || `Twelve Data API error for ${ticker}`);
    }

    if (!data.values || !Array.isArray(data.values) || data.values.length === 0) {
      throw new Error(`No price time series values returned for ${ticker}`);
    }

    // Twelve Data returns newest first. Reverse to get oldest first.
    const bars = data.values.map(bar => ({
      date: bar.datetime,
      open: Number(bar.open),
      high: Number(bar.high),
      low: Number(bar.low),
      close: Number(bar.close),
      volume: Number(bar.volume)
    })).reverse();

    // Cache result
    localStorage.setItem(cacheKey, JSON.stringify({
      timestamp: now,
      values: bars
    }));

    return bars;
  }

// --- Pure Indicator Functions ---

function calculateSMA(values, window) {
  const result = new Array(values.length).fill(null);
  if (values.length < window) return result;
  for (let i = window - 1; i < values.length; i++) {
    let sum = 0;
    for (let j = i - window + 1; j <= i; j++) {
      sum += values[j];
    }
    result[i] = sum / window;
  }
  return result;
}

function calculateEMA(values, window) {
  const result = new Array(values.length).fill(null);
  if (values.length < window) return result;
  
  let sum = 0;
  for (let i = 0; i < window; i++) {
    sum += values[i];
  }
  let prevEMA = sum / window;
  result[window - 1] = prevEMA;

  const k = 2 / (window + 1);
  for (let i = window; i < values.length; i++) {
    prevEMA = (values[i] - prevEMA) * k + prevEMA;
    result[i] = prevEMA;
  }
  return result;
}

function calculateMACD(closes, fast = 12, slow = 26, signal = 9) {
  const fastEMA = calculateEMA(closes, fast);
  const slowEMA = calculateEMA(closes, slow);
  
  const macdLine = new Array(closes.length).fill(null);
  for (let i = 0; i < closes.length; i++) {
    if (fastEMA[i] !== null && slowEMA[i] !== null) {
      macdLine[i] = fastEMA[i] - slowEMA[i];
    }
  }

  const validIndices = [];
  const validMacd = [];
  for (let i = 0; i < macdLine.length; i++) {
    if (macdLine[i] !== null) {
      validIndices.push(i);
      validMacd.push(macdLine[i]);
    }
  }

  const signalLineArr = new Array(closes.length).fill(null);
  const histogramArr = new Array(closes.length).fill(null);

  if (validMacd.length >= signal) {
    const validSignal = calculateEMA(validMacd, signal);
    for (let idx = 0; idx < validIndices.length; idx++) {
      const origIdx = validIndices[idx];
      const sigVal = validSignal[idx];
      if (sigVal !== null) {
        signalLineArr[origIdx] = sigVal;
        histogramArr[origIdx] = macdLine[origIdx] - sigVal;
      }
    }
  }

  return {
    macd: macdLine,
    signal: signalLineArr,
    histogram: histogramArr
  };
}

function calculateRSI(closes, period = 14) {
  const rsi = new Array(closes.length).fill(null);
  if (closes.length <= period) return rsi;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  let rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  rsi[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + rs));

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff >= 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;

    if (avgLoss === 0) {
      rsi[i] = 100;
    } else {
      const currentRs = avgGain / avgLoss;
      rsi[i] = 100 - (100 / (1 + currentRs));
    }
  }

  return rsi;
}

function calculateAnnualisedVolatility(closes, window = 60) {
  if (closes.length < 2) return { annualisedVol: 0, dailyVol: 0 };
  const returns = [];
  const sliceCloses = closes.slice(-Math.min(closes.length, window + 1));
  for (let i = 1; i < sliceCloses.length; i++) {
    const r = (sliceCloses[i] - sliceCloses[i - 1]) / sliceCloses[i - 1];
    returns.push(r);
  }
  if (returns.length === 0) return { annualisedVol: 0, dailyVol: 0 };

  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / (returns.length > 1 ? returns.length - 1 : 1);
  const dailyVol = Math.sqrt(variance);
  const annualisedVol = dailyVol * Math.sqrt(252);

  return { annualisedVol, dailyVol };
}

function calculateMaxDrawdown(closes, window = 252) {
  if (closes.length === 0) return 0;
  const sliceCloses = closes.slice(-Math.min(closes.length, window));
  let peak = sliceCloses[0];
  let maxDd = 0;

  for (let i = 0; i < sliceCloses.length; i++) {
    const price = sliceCloses[i];
    if (price > peak) {
      peak = price;
    }
    const dd = (price - peak) / peak;
    if (dd < maxDd) {
      maxDd = dd;
    }
  }
  return Math.abs(maxDd);
}

function calculateOBV(closes, volumes, lookback = 20) {
  const obvArr = new Array(closes.length).fill(0);
  if (closes.length === 0) return { obv: obvArr, obvChange20: 0 };

  obvArr[0] = volumes[0] || 0;
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > closes[i - 1]) {
      obvArr[i] = obvArr[i - 1] + (volumes[i] || 0);
    } else if (closes[i] < closes[i - 1]) {
      obvArr[i] = obvArr[i - 1] - (volumes[i] || 0);
    } else {
      obvArr[i] = obvArr[i - 1];
    }
  }

  const lookbackIdx = Math.max(0, closes.length - 1 - lookback);
  const obvChange20 = obvArr[closes.length - 1] - obvArr[lookbackIdx];
  return { obv: obvArr, obvChange20 };
}

function calculatePeriodReturn(closes, lookback = 63) {
  if (closes.length <= 1) return 0;
  const targetIdx = Math.max(0, closes.length - 1 - lookback);
  const startPrice = closes[targetIdx];
  const endPrice = closes[closes.length - 1];
  if (!startPrice || startPrice === 0) return 0;
  return (endPrice - startPrice) / startPrice;
}

function calculateMedianDailyVolume(volumes, lookback = 20) {
  if (!volumes || volumes.length === 0) return 0;
  const sliceVols = volumes.slice(-Math.min(volumes.length, lookback)).filter(v => v !== undefined && v !== null);
  if (sliceVols.length === 0) return 0;
  const sorted = [...sliceVols].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

// --- Score Computation Functions ---

function computeTrendScore(stock, benchmark) {
  if (stock.status === 'data-error') return 0;
  const ind = stock.indicators;
  if (!ind || ind.sma200 === undefined) return 0;

  const priceVsSma200 = Math.max(0, Math.min(100, 50 + ((stock.price / (ind.sma200 || 1)) - 1) * 250));
  const sma50VsSma200 = Math.max(0, Math.min(100, 50 + ((ind.sma50 / (ind.sma200 || 1)) - 1) * 250));
  const rs = Math.max(0, Math.min(100, 50 + (ind.return63d - (benchmark.return63d || 0)) * 250));

  return (0.40 * priceVsSma200) + (0.35 * sma50VsSma200) + (0.25 * rs);
}

function computeMomentumScore(stock) {
  if (stock.status === 'data-error') return 0;
  const ind = stock.indicators;
  if (!ind || ind.rsi === undefined) return 0;

  // Discrete bands for RSI
  let rsiScore = 50;
  if (ind.rsi > 70) rsiScore = 100;
  else if (ind.rsi > 60) rsiScore = 75;
  else if (ind.rsi >= 40) rsiScore = 50;
  else if (ind.rsi >= 30) rsiScore = 25;
  else rsiScore = 0;

  // Self-scaling MACD
  const macdScore = Math.max(0, Math.min(100, 50 + (ind.macdHistogram / (stock.price || 1)) * 2500));

  return (0.50 * rsiScore) + (0.50 * macdScore);
}

function computeVolumeScore(stock) {
  if (stock.status === 'data-error') return 0;
  const ind = stock.indicators;
  if (!ind || ind.medianDailyVolume === undefined) return 0;

  const ratio = (ind.medianDailyVolume || 0) / (ind.medianDailyVolume60 || 1);
  const ratioScore = Math.max(0, Math.min(100, 50 + (ratio - 1) * 100));

  // OBV trend
  const obvScore = Math.max(0, Math.min(100, 50 + (ind.obvChange20 / (ind.medianDailyVolume * 20 || 1)) * 250));

  return (0.50 * ratioScore) + (0.50 * obvScore);
}

function computeRiskScoreAndFinal(portfolioState) {
  // First pass: Calculate Risk by ranking within buckets
  const buckets = Object.keys(CONFIG.universe);
  
  buckets.forEach(bucket => {
    const peers = portfolioState.stocks.filter(s => s.bucket === bucket && s.status !== 'data-error');
    if (peers.length === 0) return;

    // Rank by annualized Volatility (lowest = best)
    const sortedByVol = [...peers].sort((a, b) => (a.indicators.annualisedVol || 0) - (b.indicators.annualisedVol || 0));
    sortedByVol.forEach((stock, index) => {
      stock.tempVolPercentile = peers.length > 1 ? (peers.length - 1 - index) / (peers.length - 1) * 100 : 50;
    });

    // Rank by Max Drawdown (lowest = best)
    const sortedByDd = [...peers].sort((a, b) => (a.indicators.maxDrawdown || 0) - (b.indicators.maxDrawdown || 0));
    sortedByDd.forEach((stock, index) => {
      stock.tempDdPercentile = peers.length > 1 ? (peers.length - 1 - index) / (peers.length - 1) * 100 : 50;
    });

    // Compute Risk Score
    peers.forEach(stock => {
      const riskScore = (0.60 * stock.tempVolPercentile) + (0.40 * stock.tempDdPercentile);
      
      stock.components = stock.components || {};
      stock.components.risk = Math.max(0, Math.min(100, riskScore));
    });
  });

  // Second pass: Final Score and Contributors/Detractors
  portfolioState.stocks.forEach(stock => {
    if (stock.status === 'data-error') return;

    const weights = CONFIG.scoreWeights[stock.bucket];
    stock.components.sentiment = 50; // Neutral for now

    const finalScore = 
      (stock.components.trend * weights.trend) +
      (stock.components.momentum * weights.momentum) +
      (stock.components.risk * weights.risk) +
      (stock.components.volume * weights.volume) +
      (stock.components.sentiment * weights.sentiment);

    stock.finalScore = Math.max(0, Math.min(100, finalScore));

    // Calculate contributors and detractors
    const devs = [
      { name: 'Trend', dev: (stock.components.trend - 50) * weights.trend },
      { name: 'Momentum', dev: (stock.components.momentum - 50) * weights.momentum },
      { name: 'Risk', dev: (stock.components.risk - 50) * weights.risk },
      { name: 'Volume', dev: (stock.components.volume - 50) * weights.volume },
      { name: 'Sentiment', dev: (stock.components.sentiment - 50) * weights.sentiment }
    ];

    devs.sort((a, b) => b.dev - a.dev); // highest positive first

    stock.topContributors = devs.filter(d => d.dev > 0).slice(0, 2).map(d => d.name);
    
    const negs = devs.filter(d => d.dev < 0).sort((a, b) => a.dev - b.dev); // most negative first
    stock.topDetractors = negs.slice(0, 2).map(d => d.name);
  });
}


  function renderStocksStatus() {
    if (!stocksDataListEl) return;

    // Render MSFT Diagnostic Panel if MSFT exists in portfolioState.stocks
    const msftStock = portfolioState.stocks.find(s => s.ticker === 'MSFT');
    const diagContainer = document.getElementById('msft-diagnostic-container');
    const diagContent = document.getElementById('msft-diagnostic-content');
    if (msftStock && diagContainer && diagContent && msftStock.status === 'validated') {
      diagContainer.style.display = 'block';
      const bars = msftStock.prices || [];
      const len = bars.length;
      const firstBar = len > 0 ? bars[0] : { date: 'N/A', close: 0 };
      const lastBar = len > 0 ? bars[len - 1] : { date: 'N/A', close: 0 };
      const sma50Last3 = (msftStock.sma50Arr || []).slice(-3).map(v => v !== null && v !== undefined ? v.toFixed(2) : 'null');
      const sma200Last3 = (msftStock.sma200Arr || []).slice(-3).map(v => v !== null && v !== undefined ? v.toFixed(2) : 'null');
      const exactIndexRead = len > 0 ? len - 1 : 'N/A';

      const closes = bars.map(b => b.close);
      
      // Independent fresh calculations for cross-check
      let freshSma50 = null;
      if (closes.length >= 50) {
        const slice50 = closes.slice(-50);
        freshSma50 = slice50.reduce((a, b) => a + b, 0) / 50;
      }

      let freshSma200 = null;
      if (closes.length >= 200) {
        const slice200 = closes.slice(-200);
        freshSma200 = slice200.reduce((a, b) => a + b, 0) / 200;
      }

      let minBar = len > 0 ? bars[0] : null;
      let maxBar = len > 0 ? bars[0] : null;
      bars.forEach(b => {
        if (b.close < minBar.close) minBar = b;
        if (b.close > maxBar.close) maxBar = b;
      });

      diagContent.innerHTML = `
        <div>1. bars.length: <strong>${len}</strong></div>
        <div>2. bars[0] (Oldest): Date = <strong>${firstBar.date}</strong>, Close = <strong>$${firstBar.close}</strong></div>
        <div>3. bars[bars.length-1] (Newest): Date = <strong>${lastBar.date}</strong>, Close = <strong>$${lastBar.close}</strong></div>
        <div>4. Last 3 values of sma50 array: [<strong>${sma50Last3.join(', ')}</strong>]</div>
        <div>4b. SMA50 Cross-Check: Function sma50[${len-1}] = <strong>$${msftStock.indicators.sma50?.toFixed(2) || 'null'}</strong> vs Fresh Loop Mean (last 50) = <strong>$${freshSma50 !== null ? freshSma50.toFixed(2) : 'N/A'}</strong></div>
        <div>5. Last 3 values of sma200 array: [<strong>${sma200Last3.join(', ')}</strong>]</div>
        <div>5b. SMA200 Cross-Check: Function sma200[${len-1}] = <strong>$${msftStock.indicators.sma200?.toFixed(2) || 'null'}</strong> vs Fresh Loop Mean (last 200) = <strong>$${freshSma200 !== null ? freshSma200.toFixed(2) : 'N/A'}</strong></div>
        <div>6. Full Array Min Close: <strong>$${minBar ? minBar.close.toFixed(2) : 'N/A'}</strong> on <strong>${minBar ? minBar.date : 'N/A'}</strong> | Max Close: <strong>$${maxBar ? maxBar.close.toFixed(2) : 'N/A'}</strong> on <strong>${maxBar ? maxBar.date : 'N/A'}</strong></div>
        <div>7. Exact array index read for indicators: <strong>closes.length - 1 = ${exactIndexRead}</strong></div>
      `;
    } else if (diagContainer) {
      if (diagContainer) diagContainer.style.display = 'none';
    }

    let html = `
      <div style="margin-bottom: 1rem; padding: 0.75rem; background: #e8f5e9; border-radius: 4px; font-size: 0.9rem;">
        <strong>Benchmark (SPY):</strong> ${portfolioState.benchmark.ticker} — Price: <strong>$${portfolioState.benchmark.price?.toFixed(2) || 'N/A'}</strong> | SMA200: <strong>$${portfolioState.benchmark.sma200?.toFixed(2) || 'N/A'}</strong> | 63d Return: <strong>${((portfolioState.benchmark.return63d || 0)*100).toFixed(1)}%</strong> (Bars: ${portfolioState.benchmark.barsAvailable})
      </div>
      <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 0.75rem;">
    `;

    portfolioState.stocks.forEach(s => {
      const isError = s.status === 'data-error';
      const bg = isError ? '#ffebee' : '#f4f3ef';
      const borderCol = isError ? 'var(--error)' : 'var(--line)';
      html += `
        <div style="background: ${bg}; border: 1px solid ${borderCol}; padding: 0.75rem; border-radius: 4px; font-size: 0.85rem;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.3rem;">
            <div><strong>${s.ticker}</strong> <span style="font-size: 0.75rem; color: #666; text-transform: uppercase;">(${s.bucket})</span></div>
            <span style="font-size: 0.75rem; padding: 0.1rem 0.4rem; border-radius: 3px; background: ${isError ? '#c62828' : '#2e7d32'}; color: white;">${s.status}</span>
          </div>
          ${isError ? `<div style="color: var(--error); font-size: 0.75rem; margin-top: 0.25rem;">Error: ${s.errorReason}</div>` : `
            <div style="font-family: monospace; display: grid; gap: 0.15rem; color: #333;">
              <div>Price: <strong>$${s.price?.toFixed(2)}</strong> | As Of: ${s.priceAsOf}</div>
              <div>RSI(14): <strong>${s.indicators.rsi?.toFixed(1) || 'N/A'}</strong> | MACD Hist: <strong>${s.indicators.macdHistogram?.toFixed(2) || 'N/A'}</strong></div>
              <div>SMA50: $${s.indicators.sma50?.toFixed(2) || 'N/A'} | SMA200: $${s.indicators.sma200?.toFixed(2) || 'N/A'}</div>
              <div>Ann. Vol: <strong>${((s.indicators.annualisedVol || 0)*100).toFixed(1)}%</strong> | Max DD: <strong>${((s.indicators.maxDrawdown || 0)*100).toFixed(1)}%</strong></div>
              <div>63d Return: <strong>${((s.indicators.return63d || 0)*100).toFixed(1)}%</strong> | Bars: ${s.barsAvailable}</div>
              <div style="border-top: 1px solid #ccc; margin-top: 0.25rem; padding-top: 0.25rem; display: grid; grid-template-columns: 1fr 1fr; gap: 0.2rem; font-size: 0.75rem;">
                <div>Trend: <strong>${s.components?.trend?.toFixed(1) || 0}</strong></div>
                <div>Momentum: <strong>${s.components?.momentum?.toFixed(1) || 0}</strong></div>
                <div>Risk: <strong>${s.components?.risk?.toFixed(1) || 0}</strong></div>
                <div>Volume: <strong>${s.components?.volume?.toFixed(1) || 0}</strong></div>
                <div>Sentiment: <strong>${s.components?.sentiment?.toFixed(1) || 0}</strong></div>
                <div style="color: var(--accent); font-weight: bold;">Final: ${s.finalScore?.toFixed(1) || 0}</div>
              </div>
              <div style="font-size: 0.7rem; color: #555; margin-top: 0.2rem;">
                + <strong>${s.topContributors?.join(', ') || 'N/A'}</strong> | - <strong>${s.topDetractors?.join(', ') || 'N/A'}</strong>
              </div>
              ${s.existingShares > 0 ? `<div style="margin-top: 0.25rem; color: #1565c0;">Existing Holding: ${s.existingShares.toLocaleString()} shares</div>` : ''}
            </div>
          `}
        </div>
      `;
    });
    html += '</div>';
    stocksDataListEl.innerHTML = html;
  }

  if (runBtn) {
    runBtn.addEventListener('click', async () => {
      const twelveDataKey = document.getElementById('twelvedata-key')?.value.trim();
      if (!twelveDataKey) {
        alert('Please enter your Twelve Data API key in the API Keys Configuration section before running analysis.');
        return;
      }

      const forceRefresh = forceRefreshCb ? forceRefreshCb.checked : false;
      runBtn.disabled = true;
      runBtn.textContent = 'Running Analysis...';
      if (progressEl) progressEl.textContent = 'Starting analysis queue...';

      try {
        // 1. Fetch Benchmark (SPY) first
        if (progressEl) progressEl.textContent = 'Fetching benchmark SPY... (1 of 21)';
        try {
          const spyBars = await fetchDailyPrices(CONFIG.benchmark, twelveDataKey, forceRefresh);
          const latestSpy = spyBars[spyBars.length - 1];
          const spyCloses = spyBars.map(b => b.close);
          const spySma200Arr = calculateSMA(spyCloses, CONFIG.indicators.smaSlow);
          const spyReturn63 = calculatePeriodReturn(spyCloses, CONFIG.indicators.relativeStrengthDays);

          portfolioState.benchmark = {
            ticker: CONFIG.benchmark,
            price: latestSpy.close,
            date: latestSpy.date,
            barsAvailable: spyBars.length,
            sma200: spySma200Arr[spySma200Arr.length - 1],
            return63d: spyReturn63,
            aboveSma200: latestSpy.close > (spySma200Arr[spySma200Arr.length - 1] || 0),
            bars: spyBars
          };
        } catch (err) {
          console.error("Benchmark SPY fetch error:", err);
          portfolioState.benchmark = {
            ticker: CONFIG.benchmark,
            price: 0,
            date: 'Error',
            barsAvailable: 0,
            error: err.message
          };
        }

        // Collect all universe tickers with their bucket association
        const universeTasks = [];
        for (const [bucketKey, bucketObj] of Object.entries(CONFIG.universe)) {
          bucketObj.tickers.forEach(ticker => {
            universeTasks.push({ ticker, bucket: bucketKey });
          });
        } // total 20 tickers

        portfolioState.stocks = [];
        let completedCount = 1; // SPY is 1

        for (const task of universeTasks) {
          completedCount++;
          if (progressEl) {
            progressEl.textContent = `Fetching prices… ${completedCount} of 21 (${task.ticker})`;
          }

          const existingHolding = portfolioState.inputs.existingHoldings.find(h => h.ticker === task.ticker);
          const existingShares = existingHolding ? existingHolding.shares : 0;

          try {
            const bars = await fetchDailyPrices(task.ticker, twelveDataKey, forceRefresh);
            const latestBar = bars[bars.length - 1];
            const closes = bars.map(b => b.close);
            const volumes = bars.map(b => b.volume);

            const sma50Arr = calculateSMA(closes, CONFIG.indicators.smaFast);
            const sma200Arr = calculateSMA(closes, CONFIG.indicators.smaSlow);
            const rsiArr = calculateRSI(closes, CONFIG.indicators.rsiPeriod);
            const macdObj = calculateMACD(closes, CONFIG.indicators.macdFast, CONFIG.indicators.macdSlow, CONFIG.indicators.macdSignal);
            const volObj = calculateAnnualisedVolatility(closes, CONFIG.indicators.volLookback);
            const maxDd = calculateMaxDrawdown(closes, CONFIG.indicators.drawdownLookback);
            const obvObj = calculateOBV(closes, volumes, CONFIG.indicators.obvLookback);
            const return63d = calculatePeriodReturn(closes, CONFIG.indicators.relativeStrengthDays);
            const medianVol = calculateMedianDailyVolume(volumes, CONFIG.volumeLookbackDays);
            const medianVol60 = calculateMedianDailyVolume(volumes, 60);

            const lastIdx = closes.length - 1;
            const indicators = {
              sma50: sma50Arr[lastIdx],
              sma200: sma200Arr[lastIdx],
              rsi: rsiArr[lastIdx],
              macd: macdObj.macd[lastIdx],
              macdSignal: macdObj.signal[lastIdx],
              macdHistogram: macdObj.histogram[lastIdx],
              annualisedVol: volObj.annualisedVol,
              dailyVol: volObj.dailyVol,
              maxDrawdown: maxDd,
              obv: obvObj.obv[lastIdx],
              obvChange20: obvObj.obvChange20,
              return63d: return63d,
              medianDailyVolume: medianVol,
              medianDailyVolume60: medianVol60
            };

            const stockObj = {
              ticker: task.ticker,
              name: task.ticker,
              bucket: task.bucket,
              price: latestBar.close,
              priceAsOf: latestBar.date,
              barsAvailable: bars.length,
              existingShares,
              prices: bars,
              sma50Arr,
              sma200Arr,
              indicators,
              status: 'validated'
            };

            stockObj.components = {
              trend: computeTrendScore(stockObj, portfolioState.benchmark),
              momentum: computeMomentumScore(stockObj),
              volume: computeVolumeScore(stockObj),
              sentiment: 50 // Default
            };

            portfolioState.stocks.push(stockObj);
          } catch (err) {
            console.error(`Failed to fetch ${task.ticker}:`, err);
            portfolioState.stocks.push({
              ticker: task.ticker,
              name: task.ticker,
              bucket: task.bucket,
              price: 0,
              priceAsOf: 'N/A',
              barsAvailable: 0,
              existingShares,
              prices: [],
              indicators: {},
              components: { trend: 0, momentum: 0, risk: 0, volume: 0, sentiment: 50 },
              status: 'data-error',
              errorReason: err.message
            });
          }

          // Throttle between calls
          if (completedCount <= 21) {
            await sleep(CONFIG.throttleMsBetweenCalls);
          }
        }

        // Second pass: Calculate risk percentiles across buckets and compute final score
        computeRiskScoreAndFinal(portfolioState);

        if (progressEl) {
          progressEl.textContent = 'Analysis price fetch and scoring complete! (21 / 21)';
        }
        renderStocksStatus();

      } catch (e) {
        console.error("Analysis execution error:", e);
        alert(`Analysis failed: ${e.message}`);
        if (progressEl) progressEl.textContent = `Error: ${e.message}`;
      } finally {
        runBtn.disabled = false;
        runBtn.textContent = 'Run Portfolio Analysis';
      }
    });
  }

  // Initial render calculation
  updateDashboardState();
});
