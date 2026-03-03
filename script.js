/**
 * Zaher Trade - Live Gold & Currency
 * Fixed: Multiple API fallbacks, retry logic, graceful degradation
 */

// Global State
let exchangeRates = {};
let goldSpotUSD = 0;
let silverSpotUSD = 0;
const GRAMS_PER_OUNCE = 31.1034768;

const REGIONS = [
    { country: 'Europe / France', currency: 'EUR', flag: '🇪🇺' },
    { country: 'United States',   currency: 'USD', flag: '🇺🇸' },
    { country: 'Canada',          currency: 'CAD', flag: '🇨🇦' },
    { country: 'Turkey',          currency: 'TRY', flag: '🇹🇷' },
    { country: 'Syria',           currency: 'SYP', flag: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 20" width="24" height="16" style="vertical-align:middle;border-radius:2px;"><rect width="30" height="6.66" y="0" fill="#239e46"/><rect width="30" height="6.66" y="6.67" fill="#ffffff"/><rect width="30" height="6.66" y="13.34" fill="#000000"/><g fill="#cc0000" transform="translate(15,10)"><polygon points="0,-3 0.7,-1 2.8,-1 1.2,0.4 1.8,2.4 0,1.2 -1.8,2.4 -1.2,0.4 -2.8,-1 -0.7,-1" transform="translate(-6,0) scale(0.7)"/><polygon points="0,-3 0.7,-1 2.8,-1 1.2,0.4 1.8,2.4 0,1.2 -1.8,2.4 -1.2,0.4 -2.8,-1 -0.7,-1" transform="translate(0,0) scale(0.7)"/><polygon points="0,-3 0.7,-1 2.8,-1 1.2,0.4 1.8,2.4 0,1.2 -1.8,2.4 -1.2,0.4 -2.8,-1 -0.7,-1" transform="translate(6,0) scale(0.7)"/></g></svg>', isSVG: true },
    { country: 'UAE',             currency: 'AED', flag: '🇦🇪' },
    { country: 'Saudi Arabia',    currency: 'SAR', flag: '🇸🇦' },
    { country: 'Qatar',           currency: 'QAR', flag: '🇶🇦' },
    { country: 'Kuwait',          currency: 'KWD', flag: '🇰🇼' },
    { country: 'Egypt',           currency: 'EGP', flag: '🇪🇬' },
    { country: 'Jordan',          currency: 'JOD', flag: '🇯🇴' },
    { country: 'Lebanon',         currency: 'LBP', flag: '🇱🇧' },
    { country: 'Iraq',            currency: 'IQD', flag: '🇮🇶' },
    { country: 'Bahrain',         currency: 'BHD', flag: '🇧🇭' },
    { country: 'Oman',            currency: 'OMR', flag: '🇴🇲' },
    { country: 'Morocco',         currency: 'MAD', flag: '🇲🇦' },
    { country: 'Algeria',         currency: 'DZD', flag: '🇩🇿' },
    { country: 'Tunisia',         currency: 'TND', flag: '🇹🇳' },
    { country: 'Libya',           currency: 'LYD', flag: '🇱🇾' },
    { country: 'Yemen',           currency: 'YER', flag: '🇾🇪' },
    { country: 'Sudan',           currency: 'SDG', flag: '🇸🇩' },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

async function fetchWithTimeout(url, timeoutMs = 8000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(id);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res;
    } catch (err) {
        clearTimeout(id);
        throw err;
    }
}

// Try a list of async factories in order; return first that resolves
async function tryInOrder(fns) {
    for (const fn of fns) {
        try {
            const result = await fn();
            if (result !== null && result !== undefined) return result;
        } catch (_) { /* try next */ }
    }
    return null;
}

// ── Fiat Rates ────────────────────────────────────────────────────────────────

async function fetchFiatRates() {
    // Primary: open.er-api.com (free, no key)
    // Fallback: frankfurter.app (free, no key, EUR base – we re-base to USD)
    const primary = async () => {
        const res = await fetchWithTimeout('https://open.er-api.com/v6/latest/USD');
        const data = await res.json();
        if (data.result !== 'success') throw new Error('bad response');
        return { rates: data.rates, ts: data.time_last_update_unix };
    };

    const fallback = async () => {
        const res = await fetchWithTimeout('https://api.frankfurter.app/latest?from=USD');
        const data = await res.json();
        if (!data.rates) throw new Error('bad response');
        // frankfurter already returns USD-based rates but doesn't include USD itself
        data.rates['USD'] = 1;
        return { rates: data.rates, ts: Math.floor(Date.now() / 1000) };
    };

    return tryInOrder([primary, fallback]);
}

// ── Gold Spot ─────────────────────────────────────────────────────────────────

// CORS proxy wrappers – try several in case one is down
function makeProxyUrl(targetUrl) {
    return [
        `https://api.allorigins.win/get?url=${encodeURIComponent(targetUrl)}`,
        `https://corsproxy.io/?${encodeURIComponent(targetUrl)}`,
        `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(targetUrl)}`,
    ];
}

async function fetchGoldViaProxy(proxyUrl, isAllorigins = false) {
    const res = await fetchWithTimeout(proxyUrl, 10000);
    const raw = await res.json();
    const text = isAllorigins ? raw.contents : (typeof raw === 'string' ? raw : JSON.stringify(raw));
    const data = JSON.parse(text);
    if (!data?.items?.[0]) throw new Error('unexpected shape');
    return { xau: data.items[0].xauPrice, xag: data.items[0].xagPrice };
}

// Fallback: frankfurter doesn't have metals; use gold-api.com (free, no key)
async function fetchGoldFromGoldAPI() {
    const res = await fetchWithTimeout('https://www.goldapi.io/api/XAU/USD', 8000);
    const data = await res.json();
    if (!data.price) throw new Error('no price');
    return { xau: data.price, xag: data.silver_price ?? 0 };
}

// Fallback2: metals-api via open proxy with hardcoded approximate ratio if all else fails
async function fetchGoldFallbackRatio(usdRate) {
    // Use forex rate from fiat + known gold/USD from a simple public endpoint
    const res = await fetchWithTimeout(
        'https://query1.finance.yahoo.com/v8/finance/chart/GC=F?interval=1m&range=1d', 10000
    );
    const data = await res.json();
    const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
    if (!price) throw new Error('no yahoo price');
    return { xau: price, xag: null };
}

async function fetchGoldSpot() {
    const goldPriceOrgUrl = 'https://data-asg.goldprice.org/dbXRates/USD';
    const proxies = makeProxyUrl(goldPriceOrgUrl);

    return tryInOrder([
        () => fetchGoldViaProxy(proxies[0], true),   // allorigins
        () => fetchGoldViaProxy(proxies[1], false),  // corsproxy.io
        () => fetchGoldViaProxy(proxies[2], false),  // codetabs
        fetchGoldFromGoldAPI,                        // gold-api.com
        fetchGoldFallbackRatio,                      // Yahoo Finance
    ]);
}

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
    startPulse();
    populateDropdowns();
    await fetchMarketData();
    setupEventListeners();

    // Auto-refresh every 3 minutes
    setInterval(fetchMarketData, 3 * 60 * 1000);
});

function startPulse() {
    setInterval(() => {
        const pulse = document.querySelector('.pulse-dot');
        if (!pulse) return;
        pulse.style.transform = 'scale(1.2)';
        setTimeout(() => (pulse.style.transform = 'scale(1)'), 300);
    }, 2000);
}

async function fetchMarketData() {
    // Show loading state
    document.getElementById('gold-table-body').innerHTML =
        '<tr><td colspan="5" class="loading-cell">Loading live data…</td></tr>';

    // Run both fetches in parallel; each has its own fallback chain
    const [fiatResult, goldResult] = await Promise.allSettled([
        fetchFiatRates(),
        fetchGoldSpot(),
    ]);

    // Process fiat
    if (fiatResult.status === 'fulfilled' && fiatResult.value) {
        exchangeRates = fiatResult.value.rates;
        updateLastUpdated('fiat-last-updated', fiatResult.value.ts);
    } else {
        console.warn('Fiat rates unavailable:', fiatResult.reason);
        showPartialError('fiat-last-updated', 'Rates unavailable');
    }

    // Process gold
    if (goldResult.status === 'fulfilled' && goldResult.value) {
        goldSpotUSD = goldResult.value.xau;
        silverSpotUSD = goldResult.value.xag ?? 0;
        updateLastUpdated('gold-last-updated', Math.floor(Date.now() / 1000));
    } else {
        console.warn('Gold price unavailable:', goldResult.reason);
        showPartialError('gold-last-updated', 'Gold data unavailable');
        document.getElementById('gold-table-body').innerHTML =
            `<tr><td colspan="5" style="color:#e2b745;text-align:center;padding:2rem;">
                ⚠️ Gold price temporarily unavailable.<br>
                <small style="color:#a0a5b1">Currency converter below is still working.</small>
            </td></tr>`;
    }

    // Render whatever we have
    renderQuickGlance();
    if (goldSpotUSD && Object.keys(exchangeRates).length) renderGoldTable();
    calculateExchange();
}

// ── UI Helpers ────────────────────────────────────────────────────────────────

function updateLastUpdated(elementId, unixTime) {
    const el = document.getElementById(elementId);
    if (!el) return;
    const date = new Date(unixTime * 1000);
    el.innerHTML = `Live &bull; ${date.toLocaleTimeString()}`;
}

function showPartialError(elementId, msg) {
    const el = document.getElementById(elementId);
    if (!el) return;
    el.innerHTML = `⚠️ ${msg}`;
    el.style.color = '#e2b745';
}

function formatCurrency(value, currencyCode, minimumFractionDigits = 2) {
    if (!value || isNaN(value)) return '--';
    try {
        return new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: currencyCode,
            minimumFractionDigits,
            maximumFractionDigits: minimumFractionDigits,
        }).format(value);
    } catch (_) {
        // Fallback for unsupported currency codes (e.g. SYP on some browsers)
        return value.toFixed(minimumFractionDigits) + ' ' + currencyCode;
    }
}

function renderQuickGlance() {
    document.getElementById('spot-usd').textContent =
        goldSpotUSD ? formatCurrency(goldSpotUSD, 'USD') : '--';
    const goldSpotEUR = goldSpotUSD * (exchangeRates['EUR'] || 1);
    document.getElementById('spot-eur').textContent =
        goldSpotEUR ? formatCurrency(goldSpotEUR, 'EUR') : '--';
    document.getElementById('spot-silver-usd').textContent =
        silverSpotUSD ? formatCurrency(silverSpotUSD, 'USD') : '--';
}

function getGoldGramPrice(karatRatio, currencyRate) {
    return (goldSpotUSD / GRAMS_PER_OUNCE) * currencyRate * karatRatio;
}

function renderGoldTable() {
    const tbody = document.getElementById('gold-table-body');
    tbody.innerHTML = '';

    REGIONS.forEach(region => {
        const rate = exchangeRates[region.currency] || 1;
        const k24 = getGoldGramPrice(1,      rate);
        const k22 = getGoldGramPrice(22/24,  rate);
        const k21 = getGoldGramPrice(21/24,  rate);
        const k18 = getGoldGramPrice(18/24,  rate);

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>
                <div class="region-cell">
                    <span class="region-icon" style="display:inline-flex;align-items:center;">${region.flag}</span>
                    <div>
                        <strong>${region.country}</strong>
                        <span class="region-badge">${region.currency}</span>
                    </div>
                </div>
            </td>
            <td>${formatCurrency(k24, region.currency)}</td>
            <td>${formatCurrency(k22, region.currency)}</td>
            <td style="color:var(--accent-gold);">${formatCurrency(k21, region.currency)}</td>
            <td>${formatCurrency(k18, region.currency)}</td>
        `;
        tbody.appendChild(tr);
    });
}

// ── Currency Exchange ─────────────────────────────────────────────────────────

const EXTRA_ARAB_CURRENCIES = [
    'DZD','BHD','EGP','IQD','JOD','KWD','LBP','LYD','MAD','OMR',
    'QAR','SAR','SDG','SYP','TND','AED','YER'
];

function populateDropdowns() {
    const fromSelect = document.getElementById('exchange-from');
    const toSelect   = document.getElementById('exchange-to');

    const focusList  = ['USD', 'EUR', 'CAD', 'TRY'];
    const uniqueCodes = [...new Set([...focusList, ...EXTRA_ARAB_CURRENCIES])].sort();

    const optionsHTML = uniqueCodes.map(c => `<option value="${c}">${c}</option>`).join('');
    fromSelect.innerHTML = optionsHTML;
    toSelect.innerHTML   = optionsHTML;

    fromSelect.value = 'USD';
    toSelect.value   = 'EUR';
}

function calculateExchange() {
    const amount = parseFloat(document.getElementById('exchange-amount').value) || 0;
    const from   = document.getElementById('exchange-from').value;
    const to     = document.getElementById('exchange-to').value;

    if (!exchangeRates[from] || !exchangeRates[to]) {
        document.getElementById('exchange-result').textContent = 'Live rates pending…';
        return;
    }

    const fromRate = exchangeRates[from];
    const toRate   = exchangeRates[to];
    const result   = (amount / fromRate) * toRate;
    const unitRate = toRate / fromRate;

    document.getElementById('exchange-result').textContent = formatCurrency(result, to, 2);
    document.getElementById('exchange-rate-info').textContent =
        `1 ${from} = ${unitRate.toFixed(4)} ${to}`;
}

function setupEventListeners() {
    ['exchange-amount', 'exchange-from', 'exchange-to'].forEach(id => {
        const el = document.getElementById(id);
        el.addEventListener('input',  calculateExchange);
        el.addEventListener('change', calculateExchange);
    });

    document.getElementById('swap-currencies').addEventListener('click', () => {
        const from = document.getElementById('exchange-from');
        const to   = document.getElementById('exchange-to');
        [from.value, to.value] = [to.value, from.value];
        calculateExchange();
    });

    document.querySelectorAll('.pair-chip').forEach(chip => {
        chip.addEventListener('click', e => {
            document.querySelectorAll('.pair-chip').forEach(c => c.classList.remove('active'));
            e.target.classList.add('active');
            document.getElementById('exchange-from').value = e.target.dataset.from;
            document.getElementById('exchange-to').value   = e.target.dataset.to;
            calculateExchange();
        });
    });
}
