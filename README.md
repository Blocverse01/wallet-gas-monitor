# Wallet Gas Monitor

Monitors gas wallet balances across multiple EVM chains and Solana. Sends Telegram alerts when balances drop below a configurable USD threshold.

## Supported Chains
- Ethereum, Base, Polygon, Optimism, Arbitrum, Celo, BSC
- Solana

## Setup

1. Install dependencies:
```bash
npm install
```

2. Copy and configure:
```bash
cp config.example.json config.json
```

Edit `config.json` with your:
- EVM and Solana wallet addresses
- USD threshold for alerts
- Telegram bot token and chat ID

3. Run:
```bash
node index.js
```

## Configuration

| Field | Description |
|-------|-------------|
| `threshold_usd` | Alert when balance drops below this USD value |
| `check_interval_minutes` | How often to check balances |
| `alert_cooldown_hours` | Minimum hours between repeated alerts per chain |
| `evm_address` | Your EVM hot wallet address |
| `solana_address` | Your Solana hot wallet address |

## How It Works
- Fetches native token prices from CoinGecko
- Checks balances on all configured chains
- Sends Telegram alerts for low balances
- Saves status to `latest-status.json` for external monitoring
- Respects cooldown to avoid alert spam
