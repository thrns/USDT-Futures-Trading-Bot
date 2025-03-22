import { parentPort, workerData } from 'worker_threads';
import dotenv from 'dotenv-esm';
import { USDMClient } from 'binance';
import { ATRealDb } from '../client.js';
import { get, ref, update } from 'firebase/database';

dotenv.config();

const client = new USDMClient({
  api_key: process.env.BINANCE_API_KEY,
  api_secret: process.env.BINANCE_API_SECRET,
});

export async function getPosition(coin) {
  const snapshot = await get(ref(ATRealDb, `/positions/${coin}`));
  return snapshot.exists() ? snapshot.val() : {};
}

export async function updatePosition(coin, data) {
  await update(ref(ATRealDb, `/positions/${coin}`), data);
}

export async function getUsdtBalance() {
  const snapshot = await get(ref(ATRealDb, '/balance/usdt'));
  return snapshot.exists() ? parseFloat(snapshot.val()) : 0;
}

export async function updateUsdtBalance(newBalance) {
  await update(ref(ATRealDb, '/balance'), { usdt: newBalance });
}

async function storeOpenPosition(symbol, side, size, entryPrice, balance) {
  await updatePosition(symbol, {
    side,
    size,
    entryPrice,
    updatedAt: Date.now(),
  });
  await updateUsdtBalance(balance);
}

async function closeStoredPosition(symbol) {
  await updatePosition(symbol, {
    side: '',
    size: 0,
    entryPrice: 0,
    updatedAt: Date.now(),
  });
}

function getSymbol(coin) {
  return coin.split('.')[0];
}

async function getLastPrice(symbol) {
  const ticker = await client.getSymbolPriceTicker({ symbol });
  const priceInfo = Array.isArray(ticker) ? ticker[0] : ticker;
  return parseFloat(priceInfo.price || '0');
}

async function futuresMarketBuy(symbol, quantity) {
  return client.submitNewOrder({
    symbol,
    side: 'BUY',
    type: 'MARKET',
    quantity: String(quantity),
  });
}

async function futuresMarketSell(symbol, quantity) {
  return client.submitNewOrder({
    symbol,
    side: 'SELL',
    type: 'MARKET',
    quantity: String(quantity),
  });
}

async function computeQty(spendUsdt, symbol) {
  const price = await getLastPrice(symbol);
  return price > 0 ? spendUsdt / price : 0;
}

const ProcessSignals = async (reqData) => {
  const { coin, type } = reqData || {};
  if (!coin || !type) {
    throw new Error('ProcessSignals Error: Missing coin or type in workerData.');
  }

  const symbol = getSymbol(coin);
  const position = await getPosition(symbol);
  const balance = await getUsdtBalance();

  return {
    status: 'state_loaded',
    symbol,
    requestedType: type,
    position,
    balance,
    storage: Boolean(storeOpenPosition && closeStoredPosition),
    exchange: Boolean(futuresMarketBuy && futuresMarketSell && computeQty),
  };
};

if (parentPort) {
  ProcessSignals(workerData)
    .then((result) => parentPort.postMessage({ result }))
    .catch((error) => parentPort.postMessage({ error: error.message }));
}
