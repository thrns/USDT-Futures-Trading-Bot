import { parentPort, workerData } from 'worker_threads';
import dotenv from 'dotenv-esm';
import { USDMClient } from 'binance';
import nodemailer from 'nodemailer';
import { ATRealDb } from '../client.js';
import { get, ref, update } from 'firebase/database';
import { ADX, ATR, RSI } from 'technicalindicators';

dotenv.config();

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: '', pass: '' },
});

async function sendEmail(subject, text) {
  try {
    const info = await transporter.sendMail({ from: '', to: '', subject, text });
    console.log('[Email] Sent =>', info.messageId);
  } catch (error) {
    console.error('[Email] Error sending email:', error);
  }
}

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

async function getSymbolPrecision(symbol) {
  const exchangeInfo = await client.getExchangeInfo();
  const symbolInfo = exchangeInfo.symbols.find(
    (item) => item.contractType === 'PERPETUAL' && item.symbol === symbol,
  );
  if (!symbolInfo) throw new Error(`Symbol ${symbol} not found in futures exchange info`);

  const lotSize = symbolInfo.filters.find((item) => item.filterType === 'LOT_SIZE');
  return {
    quantityPrecision: symbolInfo.quantityPrecision,
    minQty: parseFloat(lotSize.minQty),
    stepSize: parseFloat(lotSize.stepSize),
  };
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
  if (!price || price <= 0) return 0;

  const { quantityPrecision, minQty, stepSize } = await getSymbolPrecision(symbol);
  const rawQty = spendUsdt / price;
  const adjustedQty = parseFloat(
    (Math.floor(rawQty / stepSize) * stepSize).toFixed(quantityPrecision),
  );
  return adjustedQty >= minQty ? adjustedQty : 0;
}

async function submitForSide(symbol, side, quantity) {
  return side === 'BUY'
    ? futuresMarketBuy(symbol, quantity)
    : futuresMarketSell(symbol, quantity);
}

async function fillPriceFrom(order) {
  return parseFloat(order?.fills?.[0]?.price || 0);
}

async function doubleValidate(symbol) {
  try {
    const candles = await client.getKlines({ symbol, interval: '5m', limit: 50 });
    if (!candles || candles.length < 30) return false;

    const high = candles.map((c) => parseFloat(c[2]));
    const low = candles.map((c) => parseFloat(c[3]));
    const close = candles.map((c) => parseFloat(c[4]));
    const adx = ADX.calculate({ high, low, close, period: 14 }).pop()?.adx || 0;
    const atr = ATR.calculate({ high, low, close, period: 14 }).pop() || 0;
    const rsi = RSI.calculate({ values: close, period: 14 }).pop() || 0;

    return adx > 20 && atr < 1000 && rsi > 35 && rsi < 65;
  } catch (error) {
    console.error(`[doubleValidate] ${symbol}: ${error.message}`);
    return false;
  }
}

const ProcessSignals = async (reqData) => {
  const { coin, type } = reqData || {};
  if (!coin || !type) {
    throw new Error('ProcessSignals Error: Missing coin or type in workerData.');
  }

  const symbol = getSymbol(coin);
  const position = await getPosition(symbol);
  const balance = await getUsdtBalance();

  if (balance < 5) {
    const message = `Balance is only ${balance}, too low for ${symbol}.`;
    await sendEmail('Low Balance - Skipped Trade', message);
    return { status: 'no_trade', reason: 'low_balance', symbol };
  }

  const validatedTypes = ['ENTER_BUY', 'ENTER_SELL', 'RE_BUY', 'RE_SELL'];
  if (validatedTypes.includes(type) && !(await doubleValidate(symbol))) {
    await sendEmail('Signal Validation Skipped', `Validation failed for ${symbol}.`);
    return { status: 'skipped', reason: 'double_validation_failed', symbol };
  }

  switch (type) {
    case 'ENTER_BUY':
    case 'ENTER_SELL': {
      if (position && position.side) {
        return { status: 'skip_already_in_position', symbol, side: position.side };
      }
      const side = type === 'ENTER_BUY' ? 'BUY' : 'SELL';
      const quantity = await computeQty(balance * 0.25, symbol);
      if (quantity <= 0) return { status: 'skipped', reason: 'qty_too_small', symbol };

      const order = await submitForSide(symbol, side, quantity);
      const fillPrice = await fillPriceFrom(order);
      const cost = quantity * fillPrice;
      const nextBalance = balance - cost;
      await storeOpenPosition(symbol, side, quantity, fillPrice, nextBalance);
      await sendEmail(`${type} - ${symbol}`, `Executed ${type}: quantity=${quantity}, fillPrice=${fillPrice}`);
      return { status: 'success', action: type, quantity, fillPrice, cost, nextBalance };
    }

    case 'TP_BUY':
    case 'TP_SELL': {
      const side = type === 'TP_BUY' ? 'BUY' : 'SELL';
      if (position.side !== side || position.size <= 0) return { status: `no_${side.toLowerCase()}_position` };
      const partialQty = position.size * 0.25;
      if (partialQty <= 0) return { status: 'skipped', reason: 'qty_too_small' };
      const order = await submitForSide(symbol, side === 'BUY' ? 'SELL' : 'BUY', partialQty);
      const fillPrice = await fillPriceFrom(order);
      const proceeds = partialQty * fillPrice;
      const newSize = position.size - partialQty;
      await updateUsdtBalance(balance + proceeds);
      await updatePosition(symbol, { size: newSize, updatedAt: Date.now() });
      await sendEmail(`${type} - ${symbol}`, `Partial take profit: quantity=${partialQty}, fillPrice=${fillPrice}`);
      return { status: 'partial_take_profit', partialQty, fillPrice, newSize };
    }

    case 'RE_BUY':
    case 'RE_SELL': {
      const side = type === 'RE_BUY' ? 'BUY' : 'SELL';
      if (position.side !== side || position.size <= 0) return { status: `no_${side.toLowerCase()}_position` };
      const quantity = await computeQty(balance * 0.25, symbol);
      if (quantity <= 0) return { status: 'skipped', reason: 'qty_too_small' };
      const order = await submitForSide(symbol, side, quantity);
      const fillPrice = await fillPriceFrom(order);
      const cost = quantity * fillPrice;
      const newSize = position.size + quantity;
      await updateUsdtBalance(balance - cost);
      await updatePosition(symbol, { size: newSize, updatedAt: Date.now() });
      await sendEmail(`${type} - ${symbol}`, `Re-entry quantity=${quantity}, fillPrice=${fillPrice}`);
      return { status: 're_entry', quantity, fillPrice, newSize };
    }

    case 'EXIT_BUY':
    case 'EXIT_SELL': {
      const side = type === 'EXIT_BUY' ? 'BUY' : 'SELL';
      if (position.side !== side || position.size <= 0) return { status: `no_${side.toLowerCase()}_position` };
      const closeQty = position.size;
      const order = await submitForSide(symbol, side === 'BUY' ? 'SELL' : 'BUY', closeQty);
      const fillPrice = await fillPriceFrom(order);
      const proceeds = closeQty * fillPrice;
      await updateUsdtBalance(balance + proceeds);
      await closeStoredPosition(symbol);
      await sendEmail(`${type} - ${symbol}`, `Exited ${side}: quantity=${closeQty}, fillPrice=${fillPrice}`);
      return { status: `exited_${side.toLowerCase()}`, closeQty, fillPrice, proceeds };
    }

    default:
      return { status: 'error', message: `Unknown type: ${type}` };
  }
};

if (parentPort) {
  ProcessSignals(workerData)
    .then((result) => parentPort.postMessage({ result }))
    .catch((error) => parentPort.postMessage({ error: error.message }));
}
