const PROXY = 'https://proxy.cors.dev/';
const SYMBOL = 'SPY';
const UPDATE_MS = 3 * 60 * 1000;
let priceChart;

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  return 100 - (100 / (1 + gains / (losses || 1)));
}

async function fetchHourlyData() {
  const url = `${PROXY}https://query1.finance.yahoo.com/v8/finance/chart/${SYMBOL}?range=5d&interval=1h`;
  const res = await fetch(url);
  const json = await res.json();
  const result = json.chart.result[0];
  const timestamps = result.timestamp || [];
  const quote = result.indicators.quote[0];
  const labels = timestamps.map(t => new Date(t * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric' }));
  const closes = (quote.close || []).filter(c => c != null);
  const highs = (quote.high || []).filter(h => h != null);
  const lows = (quote.low || []).filter(l => l != null);
  return { labels, closes, highs, lows, current: closes.at(-1), prev: closes.at(-2) };
}

async function fetchVIX() {
  try {
    const url = `${PROXY}https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?range=1d&interval=1d`;
    const res = await fetch(url);
    const json = await res.json();
    const meta = json.chart.result[0].meta;
    return { price: meta.regularMarketPrice, prev: meta.previousClose || meta.chartPreviousClose };
  } catch (e) {
    return { price: null, prev: null };
  }
}

async function fetchVolumePath() {
  try {
    const url = `${PROXY}https://cdn.cboe.com/api/global/delayed_quotes/options/${SYMBOL}.json`;
    const res = await fetch(url);
    const json = await res.json();
    const options = json.data?.options || [];
    const now = new Date();
    const callsByExpiry = {};

    options.forEach(opt => {
      if (!opt.option || !opt.volume) return;
      const match = opt.option.match(/^([A-Z]+)(\d{6})([CP])(\d{8})$/);
      if (!match || match[3] !== 'C') return;
      const [, , dateStr] = match;
      const expiry = new Date(2000 + parseInt(dateStr.slice(0,2)), parseInt(dateStr.slice(2,4))-1, parseInt(dateStr.slice(4,6)));
      const dte = Math.round((expiry - now) / 86400000);
      if (dte < 7 || dte > 14) return;
      const strike = parseInt(match[4]) / 1000;
      const key = expiry.toISOString().slice(0,10);
      if (!callsByExpiry[key]) callsByExpiry[key] = [];
      callsByExpiry[key].push({ strike, volume: opt.volume || 0 });
    });

    let best = null, bestVol = 0;
    for (const [exp, strikes] of Object.entries(callsByExpiry)) {
      const tot = strikes.reduce((s, x) => s + x.volume, 0);
      if (tot > bestVol) { bestVol = tot; best = { expiry: exp, strikes }; }
    }
    if (!best) return { message: 'No significant 7–14 DTE call volume.', peakStrike: null };
    const top = best.strikes.reduce((a,b) => a.volume > b.volume ? a : b);
    return { expiry: best.expiry, peakStrike: top.strike, message: `Peak call volume near $${top.strike.toFixed(2)} (${best.expiry})` };
  } catch(e) {
    return { message: 'Volume data unavailable.', peakStrike: null };
  }
}

function analyze(data, vix) {
  const { closes, highs, lows, current } = data;
  const recent = closes.slice(-20);
  const high20 = Math.max(...highs.slice(-12));
  const low20 = Math.min(...lows.slice(-12));
  const ema9 = recent.slice(-9).reduce((a,b)=>a+b,0) / Math.min(9, recent.length);
  const ema21 = recent.slice(-21).reduce((a,b)=>a+b,0) / Math.min(21, recent.length);
  const rsi = calcRSI(closes);
  const range = high20 - low20;
  const atr = range / 12;

  const dte = 10.5;
  const iv = (vix?.price || 15) / 100;
  const expectedMove = current * iv * Math.sqrt(dte / 365);

  const aboveEma9 = current > ema9;
  const aboveEma21 = current > ema21;
  const rsiOk = rsi > 48 && rsi < 72;

  const checks = [
    { name: 'Above 9-EMA', pass: aboveEma9 },
    { name: 'Above 21-EMA', pass: aboveEma21 },
    { name: 'RSI supportive', pass: rsiOk },
    { name: 'Not overextended', pass: Math.abs(current - ema9) / atr < 1.7 },
    { name: 'VIX not extreme', pass: !vix?.price || vix.price < 28 }
  ];

  const score = Math.round((checks.filter(c => c.pass).length / checks.length) * 100);
  const go = score >= 70;

  return {
    current, high20, low20, ema9, ema21, rsi, atr, expectedMove,
    checks, score, go,
    upside: current + expectedMove * 0.7,
    entry: ema9,
    stop: low20 - atr * 0.2,
    vix,
    distFromEma9: ((current - ema9) / atr).toFixed(2)
  };
}

function render(analysis, data, volInfo) {
  const change = analysis.current - (data.prev || analysis.current);
  document.getElementById('currentPrice').textContent = `$${analysis.current.toFixed(2)}`;
  document.getElementById('priceChange').textContent = `${change >= 0 ? '+' : ''}${change.toFixed(2)}`;
  document.getElementById('priceChange').style.color = change >= 0 ? '#3fb950' : '#f85149';

  // Verdict
  document.getElementById('setupScore').textContent = analysis.score;
  document.getElementById('setupScore').style.color = analysis.go ? '#3fb950' : '#d29922';
  document.getElementById('verdict').textContent = analysis.go ? 'GO' : 'NO-GO';
  document.getElementById('verdict').className = 'verdict ' + (analysis.go ? 'go' : 'nogo');
  document.getElementById('verdictReason').textContent = analysis.go
    ? 'Confluence supports a weekly call.'
    : 'Not enough alignment.';
  document.getElementById('scoreExplanation').textContent =
    analysis.score >= 80 ? 'Strong setup — multiple factors aligned.' :
    analysis.score >= 70 ? 'Acceptable setup. Edge is present but not perfect.' :
    analysis.score >= 50 ? 'Borderline. More confirmation needed.' :
    'Weak alignment. Better to wait.';

  // Key Levels
  document.getElementById('levels').innerHTML = `
    <div class="level-row"><span>Recent High</span><span>$${analysis.high20.toFixed(2)}</span></div>
    <div class="level-row"><span>9-EMA</span><span>$${analysis.ema9.toFixed(2)}</span></div>
    <div class="level-row"><span>21-EMA</span><span>$${analysis.ema21.toFixed(2)}</span></div>
    <div class="level-row"><span>Recent Low</span><span>$${analysis.low20.toFixed(2)}</span></div>
  `;
  const aboveBoth = analysis.current > analysis.ema9 && analysis.current > analysis.ema21;
  document.getElementById('levelsExplanation').textContent = aboveBoth
    ? `Price is above both short-term EMAs (${analysis.distFromEma9}× ATR from 9-EMA). Structure supports continuation.`
    : `Price is not cleanly above the EMAs. Trend structure is mixed or weak for a directional call.`;

  // Expected Move
  document.getElementById('targets').innerHTML = `
    <div class="target-row"><span>Expected Move (±)</span><span>$${analysis.expectedMove.toFixed(2)}</span></div>
    <div class="target-row"><span>Upside Target</span><span class="go">$${analysis.upside.toFixed(2)}</span></div>
    <div class="target-row"><span>Approx ATR</span><span>$${analysis.atr.toFixed(2)}</span></div>
  `;
  document.getElementById('emExplanation').textContent =
    `Expected move ≈ $${analysis.expectedMove.toFixed(2)} over ~10.5 days using VIX as IV. Upside target is 70% of that move. A call has better odds if price is not already near the upper end of this range.`;

  // VIX
  const vixText = analysis.vix?.price ? analysis.vix.price.toFixed(2) : '—';
  const vixChange = analysis.vix?.price && analysis.vix?.prev ? (analysis.vix.price - analysis.vix.prev).toFixed(2) : '—';
  document.getElementById('volPanel').innerHTML = `
    <div class="level-row"><span>VIX</span><span>${vixText}</span></div>
    <div class="level-row"><span>VIX Change</span><span>${vixChange}</span></div>
    <div class="level-row"><span>Regime</span><span>${analysis.vix?.price > 22 ? 'Elevated' : 'Normal'}</span></div>
  `;
  let vixInsight = '';
  if (analysis.vix?.price) {
    if (analysis.vix.price < 16) vixInsight = 'Low VIX — option premium is relatively cheap. Favorable environment for buying calls if direction is clear.';
    else if (analysis.vix.price < 22) vixInsight = 'Normal VIX. Premium is moderate. Directional edge matters more than volatility.';
    else if (analysis.vix.price < 28) vixInsight = 'Elevated VIX. Larger expected moves but more expensive premium. Be selective with entries.';
    else vixInsight = 'High VIX. Premium is rich. Only high-conviction setups make sense for long calls.';
  } else {
    vixInsight = 'VIX data unavailable.';
  }
  document.getElementById('vixExplanation').textContent = vixInsight;

  // Momentum
  document.getElementById('momentumPanel').innerHTML = `
    <div class="level-row"><span>RSI (14)</span><span>${analysis.rsi.toFixed(1)}</span></div>
    <div class="level-row"><span>EMA Alignment</span><span class="${analysis.current > analysis.ema21 ? 'go' : 'nogo'}">${analysis.current > analysis.ema21 ? 'Bullish' : 'Mixed'}</span></div>
  `;
  let mom = '';
  if (analysis.rsi > 70) mom = 'RSI overbought. Strong momentum but higher risk of a pause or pullback.';
  else if (analysis.rsi > 55) mom = 'RSI shows healthy bullish momentum without being stretched.';
  else if (analysis.rsi > 45) mom = 'RSI neutral. Momentum is not clearly supporting calls yet.';
  else mom = 'RSI weak. Limited edge for buying calls.';
  mom += analysis.current > analysis.ema21 ? ' Price above 21-EMA supports the bullish case.' : ' Price below or near 21-EMA — trend is not confirmed.';
  document.getElementById('momentumExplanation').textContent = mom;

  // Volume Path
  document.getElementById('volumePath').innerHTML = volInfo.message
    ? `<p>${volInfo.message}</p>`
    : `<div class="level-row"><span>Peak Call Strike</span><span>$${volInfo.peakStrike.toFixed(2)}</span></div>`;
  document.getElementById('volumeExplanation').textContent = volInfo.peakStrike
    ? `Heaviest call volume in the 7–14 DTE window is near $${volInfo.peakStrike.toFixed(2)}. This strike can act as a magnet or resistance into that expiration.`
    : 'No clear call volume concentration in the 7–14 day window right now.';

  // Risk/Reward
  const risk = Math.abs(analysis.entry - analysis.stop);
  const reward = Math.abs(analysis.upside - analysis.entry);
  const rr = risk > 0 ? (reward / risk).toFixed(2) : '—';
  document.getElementById('rrPanel').innerHTML = `
    <div class="rr-row"><span>Entry Zone</span><span>$${analysis.entry.toFixed(2)}</span></div>
    <div class="rr-row"><span>Stop</span><span class="nogo">$${analysis.stop.toFixed(2)}</span></div>
    <div class="rr-row"><span>Target</span><span class="go">$${analysis.upside.toFixed(2)}</span></div>
    <div class="rr-row"><span>R:R</span><span>${rr} : 1</span></div>
  `;
  document.getElementById('rrExplanation').textContent = parseFloat(rr) >= 1.5
    ? `Risk/reward is ${rr}:1. Acceptable for a weekly call if the other factors align.`
    : `Risk/reward is only ${rr}:1. Below the 1.5:1 threshold — edge is thinner.`;

  // Checklist
  document.getElementById('checklist').innerHTML = analysis.checks.map(c =>
    `<div class="checklist-item ${c.pass ? 'pass' : 'fail'}">${c.pass ? '✓' : '○'} ${c.name}</div>`
  ).join('');
  const passed = analysis.checks.filter(c => c.pass).length;
  document.getElementById('checklistExplanation').textContent =
    `${passed} of ${analysis.checks.length} factors are aligned. The score is simply the percentage of these checks that pass.`;

  // Preferred Setup
  document.getElementById('setup').textContent = analysis.go
    ? `Long bias. Prefer calls on pullbacks toward $${analysis.ema9.toFixed(2)}. Target $${analysis.upside.toFixed(2)}. Invalidate below $${analysis.stop.toFixed(2)}.`
    : 'No clear weekly call setup. Wait for stronger confluence across levels, momentum, and volatility.';

  // Chart
  const ctx = document.getElementById('priceChart').getContext('2d');
  if (priceChart) priceChart.destroy();
  priceChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: data.labels.slice(-40),
      datasets: [{ data: data.closes.slice(-40), borderColor: '#58a6ff', borderWidth: 1.5, pointRadius: 0, tension: 0.1 }]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
        annotation: {
          annotations: {
            high: { type: 'line', yMin: analysis.high20, yMax: analysis.high20, borderColor: '#3fb950', borderDash: [4,4], label: { content: 'High', enabled: true, position: 'end' } },
            ema9: { type: 'line', yMin: analysis.ema9, yMax: analysis.ema9, borderColor: '#d29922', label: { content: '9-EMA', enabled: true, position: 'end' } },
            low: { type: 'line', yMin: analysis.low20, yMax: analysis.low20, borderColor: '#f85149', borderDash: [4,4], label: { content: 'Low', enabled: true, position: 'end' } }
          }
        }
      },
      scales: {
        x: { ticks: { maxTicksLimit: 6, color: '#8b949e' }, grid: { color: '#21262d' } },
        y: { ticks: { color: '#8b949e' }, grid: { color: '#21262d' } }
      }
    }
  });

  document.getElementById('chartStatus').textContent = `Updated ${new Date().toLocaleTimeString()} · SPY proxy`;
}

async function refresh() {
  try {
    const [data, vix] = await Promise.all([fetchHourlyData(), fetchVIX()]);
    const analysis = analyze(data, vix);
    const volInfo = await fetchVolumePath();
    render(analysis, data, volInfo);
  } catch (err) {
    document.getElementById('chartStatus').textContent = 'Data load failed.';
    console.error(err);
  }
}

refresh();
setInterval(refresh, UPDATE_MS);