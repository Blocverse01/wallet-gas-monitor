const { ethers } = require('ethers');
const { Connection, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const cron = require('node-cron');
const fs = require('fs');
const https = require('https');
const path = require('path');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const STATE_FILE = path.join(__dirname, 'state.json');

// Load or init state
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { lastAlerts: {} };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// Fetch JSON over HTTPS
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'wallet-monitor/1.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error: ${data.substring(0, 200)}`)); }
      });
    }).on('error', reject);
  });
}

// Get prices from CoinGecko
async function getPrices() {
  const ids = new Set();
  for (const chain of Object.values(config.chains)) ids.add(chain.coingecko_id);
  ids.add(config.solana.coingecko_id);
  
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${[...ids].join(',')}&vs_currencies=usd`;
  const data = await fetchJSON(url);
  return data;
}

// Check EVM balances
async function checkEVMBalances(prices) {
  const results = [];
  
  for (const [chainKey, chain] of Object.entries(config.chains)) {
    try {
      const provider = new ethers.JsonRpcProvider(chain.rpc);
      const balance = await provider.getBalance(config.evm_address);
      const balanceNum = parseFloat(ethers.formatEther(balance));
      const price = prices[chain.coingecko_id]?.usd || 0;
      const valueUSD = balanceNum * price;
      
      results.push({
        chain: chain.name,
        symbol: chain.symbol,
        balance: balanceNum,
        price,
        valueUSD,
        address: config.evm_address,
        key: `evm_${chainKey}`
      });
    } catch (err) {
      console.error(`Error checking ${chain.name}:`, err.message);
      results.push({
        chain: chain.name,
        symbol: chain.symbol,
        balance: null,
        price: 0,
        valueUSD: null,
        address: config.evm_address,
        key: `evm_${chainKey}`,
        error: err.message
      });
    }
  }
  
  return results;
}

// Check Solana balance
async function checkSolanaBalance(prices) {
  try {
    const connection = new Connection(config.solana.rpc, 'confirmed');
    const pubkey = new PublicKey(config.solana_address);
    const balance = await connection.getBalance(pubkey);
    const balanceNum = balance / LAMPORTS_PER_SOL;
    const price = prices[config.solana.coingecko_id]?.usd || 0;
    const valueUSD = balanceNum * price;
    
    return {
      chain: config.solana.name,
      symbol: config.solana.symbol,
      balance: balanceNum,
      price,
      valueUSD,
      address: config.solana_address,
      key: 'solana'
    };
  } catch (err) {
    console.error('Error checking Solana:', err.message);
    return {
      chain: config.solana.name,
      symbol: config.solana.symbol,
      balance: null,
      price: 0,
      valueUSD: null,
      address: config.solana_address,
      key: 'solana',
      error: err.message
    };
  }
}

// Send Telegram alert via Bot API
async function sendTelegramAlert(message) {
  const botToken = config.telegram.bot_token;
  const chatId = config.telegram.chat_id;
  
  const postData = JSON.stringify({
    chat_id: chatId,
    text: message,
    parse_mode: 'Markdown'
  });
  
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${botToken}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        console.log('Telegram response:', data.substring(0, 200));
        resolve();
      });
    });
    req.on('error', (e) => { console.error('Telegram send error:', e.message); reject(e); });
    req.write(postData);
    req.end();
  });
}

// Format balance for display
function fmtBal(num) {
  if (num === null) return 'Error';
  if (num < 0.0001) return num.toExponential(4);
  return num.toFixed(6);
}

function fmtUSD(num) {
  if (num === null) return 'Error';
  return '$' + num.toFixed(2);
}

// Main check
async function runCheck() {
  const timestamp = new Date().toISOString();
  console.log(`\n[${timestamp}] Running balance check...`);
  
  let prices;
  try {
    prices = await getPrices();
    console.log('Prices:', JSON.stringify(prices));
  } catch (err) {
    console.error('Failed to fetch prices:', err.message);
    return;
  }
  
  const evmResults = await checkEVMBalances(prices);
  const solResult = await checkSolanaBalance(prices);
  const allResults = [...evmResults, solResult];
  
  const state = loadState();
  const now = Date.now();
  const cooldownMs = config.alert_cooldown_hours * 60 * 60 * 1000;
  
  // Log all balances
  console.log('\n--- Balances ---');
  const lowBalances = [];
  
  for (const r of allResults) {
    const status = r.valueUSD !== null && r.valueUSD < config.threshold_usd ? '⚠️ LOW' : '✅';
    console.log(`${status} ${r.chain}: ${fmtBal(r.balance)} ${r.symbol} (${fmtUSD(r.valueUSD)})`);
    
    if (r.valueUSD !== null && r.valueUSD < config.threshold_usd) {
      const lastAlert = state.lastAlerts[r.key] || 0;
      if (now - lastAlert > cooldownMs) {
        lowBalances.push(r);
        state.lastAlerts[r.key] = now;
      } else {
        console.log(`  (alert cooldown active for ${r.chain})`);
      }
    }
  }
  
  // Send alerts for low balances
  if (lowBalances.length > 0) {
    let msg = '⚠️ *Low Gas Balance Alert*\n\n';
    
    for (const r of lowBalances) {
      const shortAddr = r.address.length > 20 
        ? r.address.slice(0, 6) + '...' + r.address.slice(-4) 
        : r.address;
      msg += `🔴 *${r.chain}*\n`;
      msg += `  Balance: ${fmtBal(r.balance)} ${r.symbol}\n`;
      msg += `  Value: ${fmtUSD(r.valueUSD)}\n`;
      msg += `  Wallet: \`${shortAddr}\`\n\n`;
    }
    
    msg += `💡 *Action needed:* Top up native tokens to ensure transactions don't fail.\n`;
    msg += `\n_Threshold: ${fmtUSD(config.threshold_usd)} | Checked: ${new Date().toLocaleString('en-NG', { timeZone: 'Africa/Lagos' })}_`;
    
    await sendTelegramAlert(msg);
    saveState(state);
    console.log(`\nAlerts sent for ${lowBalances.length} chain(s)`);
  } else {
    saveState(state);
    console.log('\nAll balances OK or alerts on cooldown.');
  }
  
  // Write latest status to file
  const statusData = {
    timestamp,
    prices,
    balances: allResults.map(r => ({
      chain: r.chain,
      symbol: r.symbol,
      balance: r.balance,
      valueUSD: r.valueUSD,
      belowThreshold: r.valueUSD !== null && r.valueUSD < config.threshold_usd
    }))
  };
  fs.writeFileSync(path.join(__dirname, 'latest-status.json'), JSON.stringify(statusData, null, 2));
}

// Run immediately on start
console.log('🔍 Wallet Balance Monitor starting...');
console.log(`EVM: ${config.evm_address}`);
console.log(`SOL: ${config.solana_address}`);
console.log(`Threshold: $${config.threshold_usd}`);
console.log(`Check interval: ${config.check_interval_minutes} minutes`);
console.log(`Alert cooldown: ${config.alert_cooldown_hours} hours`);
console.log('---');

runCheck().then(() => {
  // Schedule recurring checks
  const cronExpr = `*/${config.check_interval_minutes} * * * *`;
  cron.schedule(cronExpr, () => runCheck());
  console.log(`\nScheduled: every ${config.check_interval_minutes} minutes`);
});
