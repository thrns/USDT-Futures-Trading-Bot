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

  if (type !== 'buy' && type !== 'sell') {
    return { status: 'error', message: `Unknown type: ${type}` };
  }

  if (position && position.side) {
    return { status: 'skip_already_in_position', symbol, side: position.side };
  }

  const spendUsdt = balance * 0.25;
  const quantity = await computeQty(spendUsdt, symbol);
  if (quantity <= 0) {
    return { status: 'skipped', reason: 'qty_too_small', symbol };
  }

  const order = type === 'buy'
    ? await futuresMarketBuy(symbol, quantity)
    : await futuresMarketSell(symbol, quantity);
  const fillPrice = parseFloat(order?.fills?.[0]?.price || 0);
  const cost = quantity * fillPrice;
  const nextBalance = balance - cost;

  await storeOpenPosition(symbol, type === 'buy' ? 'BUY' : 'SELL', quantity, fillPrice, nextBalance);

  return {
    status: 'success',
    action: type,
    symbol,
    quantity,
    fillPrice,
    cost,
    balance: nextBalance,
  };
};

if (parentPort) {
  ProcessSignals(workerData)
    .then((result) => parentPort.postMessage({ result }))
    .catch((error) => parentPort.postMessage({ error: error.message }));
}
