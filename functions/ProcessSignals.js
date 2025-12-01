import { parentPort, workerData } from 'worker_threads';
import dotenv from 'dotenv-esm';
import { USDMClient } from 'binance';
import nodemailer from 'nodemailer';
import { ATRealDb } from '../client.js';
import { get, ref, update, remove } from 'firebase/database';

dotenv.config();

const LEVERAGE = 30;

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

async function storeOpenPosition(symbol, side, size, entryPrice, balance, capitalAllocated) {
  await updatePosition(symbol, {
    side,
    size,
    entryPrice,
    leverage: LEVERAGE,
    capitalAllocated,
    updatedAt: Date.now(),
  });
  await updateUsdtBalance(balance);
}

async function moveToPastPositions(symbol, position) {
  const closedAt = Date.now();
  const pastPositionsRef = ref(
    ATRealDb,
    `atheeb/pastPositions/${symbol}/${closedAt}`,
  );
  const positionRef = ref(ATRealDb, `/positions/${symbol}`);

  try {
    await update(pastPositionsRef, {
      ...position,
      closedAt,
    });
    await remove(positionRef);
    console.log(`[moveToPastPositions] Moved ${symbol} position to pastPositions.`);
  } catch (error) {
    console.error(`[moveToPastPositions] Error for ${symbol}: ${error.message}`);
    throw error;
  }
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

async function computeQty(spendUsdt, symbol) {
  const price = await getLastPrice(symbol);
  if (!price || price <= 0) return 0;

  const { quantityPrecision, minQty, stepSize } = await getSymbolPrecision(symbol);
  const effectiveUsdt = spendUsdt * LEVERAGE;
  const rawQty = effectiveUsdt / price;
  const adjustedQty = parseFloat(
    (Math.floor(rawQty / stepSize) * stepSize).toFixed(quantityPrecision),
  );
  return adjustedQty >= minQty ? adjustedQty : 0;
}

async function futuresMarketBuy(symbol, quantity) {
  const order = await client.submitNewOrder({
    symbol,
    side: 'BUY',
    type: 'MARKET',
    quantity: String(quantity),
  });
  return waitForOrderExecution(symbol, order.orderId);
}

async function futuresMarketSell(symbol, quantity) {
  const order = await client.submitNewOrder({
    symbol,
    side: 'SELL',
    type: 'MARKET',
    quantity: String(quantity),
  });
  return waitForOrderExecution(symbol, order.orderId);
}

async function waitForOrderExecution(symbol, orderId, maxRetries = 5, delayMs = 1000) {
  let retries = 0;
  while (retries < maxRetries) {
    const order = await client.getOrder({ symbol, orderId });
    if (order.status === 'FILLED') return order;

    console.log('[waitForOrderExecution] Order not filled yet. Retrying...');
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    retries += 1;
  }
  throw new Error(`Order ${orderId} not filled after ${maxRetries} retries.`);
}

function getExecutedQuantity(order, fallback) {
  return parseFloat(order?.executedQty || fallback);
}

function getAverageFillPrice(order) {
  return parseFloat(order?.avgPrice || order?.fills?.[0]?.price || 0);
}

async function reversePosition(symbol, position, nextSide, balance) {
  const closeSide = nextSide === 'BUY' ? 'SELL' : 'BUY';
  const closeOrder = closeSide === 'BUY'
    ? await futuresMarketBuy(symbol, position.size)
    : await futuresMarketSell(symbol, position.size);
  const closeQty = getExecutedQuantity(closeOrder, position.size);
  const closePrice = getAverageFillPrice(closeOrder);
  const proceeds = closeQty * closePrice;
  const realizedPnL = position.side === 'BUY'
    ? (closePrice - position.entryPrice) * closeQty
    : (position.entryPrice - closePrice) * closeQty;

  await updateUsdtBalance(balance + proceeds);
  await moveToPastPositions(symbol, {
    ...position,
    exitPrice: closePrice,
    proceeds,
    realizedPnL,
  });

  const availableBalance = balance + proceeds;
  const quantity = await computeQty(availableBalance * 0.25, symbol);
  if (quantity <= 0) {
    return { status: 'skipped', reason: 'qty_too_small', realizedPnL };
  }

  const openOrder = nextSide === 'BUY'
    ? await futuresMarketBuy(symbol, quantity)
    : await futuresMarketSell(symbol, quantity);
  const executedQuantity = getExecutedQuantity(openOrder, quantity);
  const entryPrice = getAverageFillPrice(openOrder);
  const cost = (executedQuantity * entryPrice) / LEVERAGE;
  await storeOpenPosition(symbol, nextSide, executedQuantity, entryPrice, availableBalance - cost, cost);
  await sendEmail(`Reversal to ${nextSide} - ${symbol}`, `Closed ${position.side} and opened ${nextSide}: quantity=${executedQuantity}`);
  return { status: 'success', action: `reversed_to_${nextSide.toLowerCase()}`, quantity: executedQuantity, entryPrice, realizedPnL };
}

const ProcessSignals = async (reqData) => {
  const { coin, type } = reqData || {};
  if (!coin || !type) {
    throw new Error('ProcessSignals Error: Missing coin or type in workerData.');
  }
  if (type !== 'buy' && type !== 'sell') {
    return { status: 'error', message: `Unknown type: ${type}` };
  }

  const symbol = getSymbol(coin);
  const position = await getPosition(symbol);
  const balance = await getUsdtBalance();
  if (balance < 5) {
    const message = `Balance is only ${balance}, too low for ${symbol}.`;
    await sendEmail('Low Balance - Skipped Trade', message);
    return { status: 'no_trade', reason: 'low_balance', symbol };
  }

  const requestedSide = type === 'buy' ? 'BUY' : 'SELL';
  if (position && position.side && position.side !== requestedSide) {
    return reversePosition(symbol, position, requestedSide, balance);
  }

  if (position && position.side) {
    return { status: 'skip_already_in_position', symbol, side: position.side };
  }

  const quantity = await computeQty(balance * 0.25, symbol);
  if (quantity <= 0) {
    await sendEmail('Qty Too Small - Skipped Trade', `No valid quantity for ${symbol}.`);
    return { status: 'skipped', reason: 'qty_too_small', symbol };
  }

  const order = type === 'buy'
    ? await futuresMarketBuy(symbol, quantity)
    : await futuresMarketSell(symbol, quantity);
  const executedQuantity = getExecutedQuantity(order, quantity);
  const fillPrice = getAverageFillPrice(order);
  const cost = (executedQuantity * fillPrice) / LEVERAGE;
  const nextBalance = balance - cost;
  const side = type === 'buy' ? 'BUY' : 'SELL';

  await storeOpenPosition(symbol, side, executedQuantity, fillPrice, nextBalance, cost);
  await sendEmail(`${type.toUpperCase()} - ${symbol}`, `Executed ${type}: quantity=${executedQuantity}, fillPrice=${fillPrice}`);
  return { status: 'success', action: type, quantity: executedQuantity, fillPrice, cost, nextBalance };
};

if (parentPort) {
  ProcessSignals(workerData)
    .then((result) => parentPort.postMessage({ result }))
    .catch((error) => parentPort.postMessage({ error: error.message }));
}
