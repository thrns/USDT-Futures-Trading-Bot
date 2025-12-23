/*******************************************************************************************
 * ProcessSignals.worker.js
 *
 * - Handles 8 TTR signals explicitly: ENTER_BUY, ENTER_SELL, EXIT_BUY, EXIT_SELL,
 *   TP_BUY, TP_SELL, RE_BUY, RE_SELL.
 * - Trades on Binance USDT Futures (using @tiagosiebler/binance / 'binance' package).
 * - Takes 25% partial TPs on each TP signal.
 * - Reverses a position on RE signals if double validation passes.
 * - If balance is too low, emails you that the trade was skipped.
 * - Emails on each action (partial TP, enters, exits, reversals).
 *******************************************************************************************/

import { parentPort, workerData } from "worker_threads";
import dotenv from "dotenv-esm";
import { MainClient, USDMClient } from "binance";
import nodemailer from "nodemailer";
import { ATRealDb } from "../client.js";
import { getDatabase, ref, get, update, remove } from "firebase/database";

// Indicators
import { ADX, ATR, RSI } from "technicalindicators";

dotenv.config();

// -------------------------------------------------------------------------------------
// 1) Hard-coded thresholds & config
// -------------------------------------------------------------------------------------
// const ADX_THRESHOLD = 20; // Allow weaker trends for short-term trades
// const ATR_MAX = 1000; // Looser volatility constraint
// const RSI_LOWER = 35; // Oversold
// const RSI_UPPER = 65; // Overbought
// const QUOTE_ASSET = "USDT";

// // Stop Loss multiple (example: 2 × ATR)
// const STOP_LOSS_MULTIPLIER = 2;

const LEVERAGE = 30;
// -------------------------------------------------------------------------------------
// 2) Instantiate binance client for USDT Futures
// -------------------------------------------------------------------------------------

console.log("process.env.BINANCE_API_KEY: ", process.env.BINANCE_API_KEY);
console.log("process.env.BINANCE_API_SECRET: ", process.env.BINANCE_API_SECRET);

const client = new USDMClient({
  api_key: process.env.BINANCE_API_KEY,
  api_secret: process.env.BINANCE_API_SECRET,
});

// client.getBalance()
//   .then((result) => {
//     console.log('getBalance result: ', result);
//   })
//   .catch((err) => {
//     console.error('getBalance error: ', err);
//   });

// -------------------------------------------------------------------------------------
// 3) Nodemailer Setup
// -------------------------------------------------------------------------------------
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: "",
    pass: "",
  },
});

async function sendEmail(subject, text) {
  try {
    const info = await transporter.sendMail({
      from: ``,
      to: "",
      subject,
      text,
    });
    console.log("[Email] Sent =>", info.messageId);
  } catch (err) {
    console.error("[Email] Error sending email:", err);
  }
}

// -------------------------------------------------------------------------------------
// 4) Firebase Helpers (Updated for "Atheeb" user)
// -------------------------------------------------------------------------------------

export async function getPosition(coin) {
  const positionRef = ref(ATRealDb, `/positions/${coin}`);
  const snapshot = await get(positionRef);
  return snapshot.exists() ? snapshot.val() : {};
}

export async function updatePosition(coin, data) {
  const positionRef = ref(ATRealDb, `/positions/${coin}`);
  await update(positionRef, data);
}

export async function getUsdtBalance() {
  const balanceRef = ref(ATRealDb, "/balance/usdt");
  const snapshot = await get(balanceRef);
  return snapshot.exists() ? parseFloat(snapshot.val()) : 0;
}

export async function updateUsdtBalance(newBalance) {
  const balanceRef = ref(ATRealDb, "/balance");
  await update(balanceRef, { usdt: newBalance });
}

async function moveToPastPositions(coin, position) {
  const pastPositionsRef = ref(
    ATRealDb,
    `atheeb/pastPositions/${coin}/${Date.now()}`
  );
  const positionRef = ref(ATRealDb, `/positions/${coin}`);

  try {
    // Add the current position to pastPositions
    await update(pastPositionsRef, {
      ...position,
      closedAt: Date.now(), // Add a timestamp for when the position was closed
    });

    // Remove the current position from the positions node
    await remove(positionRef);

    console.log(
      `[moveToPastPositions] Moved ${coin} position to pastPositions.`
    );
  } catch (err) {
    console.error(`[moveToPastPositions] Error for ${coin}: ${err.message}`);
    throw err;
  }
}

// -------------------------------------------------------------------------------------
// 5) Binance Futures Trading Helpers
// -------------------------------------------------------------------------------------
function getSymbol(coin) {
  console.log("${coin.split('.')[0]} :", `${coin.split(".")[0]}`);
  return `${coin.split(".")[0]}`;
}

async function futuresMarketBuy(symbol, quantity) {
  try {
    console.log("BUYING ", symbol, " QTY ", String(quantity.toFixed(2)));

    // Place market order
    const order = await client.submitNewOrder({
      symbol,
      side: "BUY",
      type: "MARKET",
      quantity: String(quantity.toFixed(2)),
    });

    console.log(`Market Buy Order Submitted: ${JSON.stringify(order)}`);

    // Fetch order details to get execution data
    const executedOrder = await waitForOrderExecution(symbol, order.orderId);

    console.log(`Executed Buy Order: ${JSON.stringify(executedOrder)}`);
    return executedOrder;
  } catch (error) {
    console.error(`Error placing market buy order: ${error.message}`);
    throw error;
  }
}

async function futuresMarketSell(symbol, quantity) {
  try {
    console.log("SELLING ", symbol, " QTY ", String(quantity.toFixed(2)));

    // Place market order
    const order = await client.submitNewOrder({
      symbol,
      side: "SELL",
      type: "MARKET",
      quantity: String(quantity.toFixed(2)),
    });

    console.log(`Market Sell Order Submitted: ${JSON.stringify(order)}`);

    // Fetch order details to get execution data
    const executedOrder = await waitForOrderExecution(symbol, order.orderId);

    console.log(`Executed Sell Order: ${JSON.stringify(executedOrder)}`);
    return executedOrder;
  } catch (error) {
    console.error(`Error placing market sell order: ${error.message}`);
    throw error;
  }
}

async function getLastPrice(symbol) {
  // returns float price
  const ticker = await client.getSymbolPriceTicker({ symbol });
  const priceInfo = Array.isArray(ticker) ? ticker[0] : ticker;
  return parseFloat(priceInfo.price || "0");
}

// -------------------------------------------------------------------------------------
// 6)waitForOrderExecution
// -------------------------------------------------------------------------------------
async function waitForOrderExecution(
  symbol,
  orderId,
  maxRetries = 5,
  delayMs = 1000
) {
  let retries = 0;

  while (retries < maxRetries) {
    const order = await client.getOrder({ symbol, orderId });
    if (order.status === "FILLED") {
      return order;
    }

    console.log(`[waitForOrderExecution] Order not filled yet. Retrying...`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    retries++;
  }

  throw new Error(`Order ${orderId} not filled after ${maxRetries} retries.`);
}

// -------------------------------------------------------------------------------------
// 7) Main: ProcessSignals
// -------------------------------------------------------------------------------------
const ProcessSignals = async (reqData) => {
  try {
    const { coin, type } = reqData;
    const refinedCoin = coin.split(".")[0];

    // sendEmail("coin & type: ", `${coin} and ${type}`);

    if (!refinedCoin || !type) {
      const msg = "ProcessSignals Error: Missing coin or type in workerData.";
      console.error(msg);
      await sendEmail("ProcessSignals Data Error", msg);
      throw new Error(msg);
    }

    // 2) Let's get the position
    const position = await getPosition(refinedCoin);
    console.log("position: ", position);
    const symbol = getSymbol(refinedCoin);

    // 3) Check our USDT Balance
    const usdtBal = await getUsdtBalance();

    // ----------------------------------------
    // HELPER FUNCTIONS
    // ----------------------------------------
    async function getSymbolPrecision(symbol) {
      try {
        if (!symbol) {
          throw new Error("Symbol is undefined or null");
        }
        console.log("Fetching precision for symbol:", symbol);

        const exchangeInfo = await client.getExchangeInfo();
        console.log("Exchange info received");

        // Filter for futures symbols
        const futuresSymbols = exchangeInfo.symbols.filter(
          (s) => s.contractType === "PERPETUAL"
        );
        console.log("Filtered Futures Symbols: ", futuresSymbols);

        // Find the specific symbol in futures symbols
        const symbolInfo = futuresSymbols.find((s) => s.symbol === symbol);
        if (!symbolInfo) {
          throw new Error(
            `Symbol ${symbol} not found in futures exchange info`
          );
        }

        console.log("symbolInfo,: ", symbolInfo);

        console.log("quantityPrecision,: ", symbolInfo.quantityPrecision);
        console.log("pricePrecision: ", symbolInfo.pricePrecision);

        return {
          quantityPrecision: symbolInfo.quantityPrecision,
          pricePrecision: symbolInfo.pricePrecision,
        };
      } catch (err) {
        console.error(`Error fetching precision for ${symbol}: ${err.message}`);
        throw err;
      }
    }

    // ----------------------------------------
    // HELPER FUNCTIONS
    // ----------------------------------------

    async function computeQty(spendUsdt, symbol) {
      const lastPrice = await getLastPrice(symbol);

      if (!lastPrice || lastPrice <= 0) {
        console.error(`[computeQty] Invalid last price: ${lastPrice}`);
        return 0;
      }

      const { quantityPrecision } = await getSymbolPrecision(symbol);
      console.log("quantityPrecision: ", quantityPrecision);
      console.log("spendUsdt: ", spendUsdt);
      console.log("lastPrice: ", lastPrice);

      // Adjust spendUsdt by leverage
      const effectiveUsdt = spendUsdt * LEVERAGE;
      console.log("Effective USDT with leverage: ", effectiveUsdt);

      const rawQty = effectiveUsdt / lastPrice;

      // Fetch symbol filters for validation
      const exchangeInfo = await client.getExchangeInfo();
      const futuresSymbol = exchangeInfo.symbols.find(
        (s) => s.symbol === symbol
      );
      const lotSizeFilter = futuresSymbol.filters.find(
        (f) => f.filterType === "LOT_SIZE"
      );
      const minNotionalFilter = futuresSymbol.filters.find(
        (f) => f.filterType === "MIN_NOTIONAL"
      );

      const minQty = parseFloat(lotSizeFilter.minQty);
      const stepSize = parseFloat(lotSizeFilter.stepSize);
      const minNotional = parseFloat(minNotionalFilter.notional);

      console.log(
        `minQty: ${minQty}, stepSize: ${stepSize}, minNotional: ${minNotional}`
      );

      // Ensure the quantity respects the precision and step size
      const adjustedQty =
        quantityPrecision === 0
          ? Math.floor(rawQty)
          : parseFloat(
              (rawQty - (rawQty % stepSize)).toFixed(quantityPrecision)
            );

      // Validate against minQty and minNotional
      if (adjustedQty < minQty) {
        console.error(
          `[computeQty] Quantity too small: adjustedQty=${adjustedQty}, notional=${
            (adjustedQty * lastPrice) / LEVERAGE
          } < ${minNotional}`
        );
        return 0;
      }

      console.log(
        `[computeQty] Valid quantity: ${adjustedQty}, notional=${
          (adjustedQty * lastPrice) / LEVERAGE
        }`
      );
      return adjustedQty;
    }

    // ----------------------------------------
    // SWITCH CASE
    // ----------------------------------------

    switch (type) {
      // ----------------------------------------
      // ENTER_BUY
      // ----------------------------------------
      case "buy": {
        // ----------------------------------------
        // Reverse a Short Position to Long
        // ----------------------------------------
        if (position && position.side === "SELL" && position.size > 0) {
          const closeQty = position.size; // Quantity of the short position to close
          console.log(
            `[BUY] Reversing short position for ${symbol}. Qty=${closeQty}`
          );

          // Close the existing short position
          const closeResult = await futuresMarketBuy(symbol, closeQty);

          // Extract the fill price and calculate proceeds
          let fillPrice = closeResult?.fills?.[0]?.price || 0;
          const proceeds = closeQty * fillPrice; // Total proceeds from closing the short

          // Compute realized PnL for the closed short position
          const realizedPnL = (position.entryPrice - fillPrice) * closeQty;

          // Move the closed position to "past_positions" in Firebase
          await moveToPastPositions(symbol, {
            ...position, // Include existing position details
            proceeds, // Proceeds from the closed position
            exitPrice: fillPrice, // Price at which the position was closed
            realizedPnL, // Realized profit/loss from the trade
            closedAt: Date.now(), // Timestamp of position closure
          });

          console.log(
            `[BUY] Short position closed for ${symbol}. Now opening a long position.`
          );

          const usdtBal = await getUsdtBalance();

          const spendUsdt = usdtBal * 0.5
          // Use a portion of the proceeds to calculate the quantity for the new long position
          const qty = await computeQty(spendUsdt, symbol); // Compute the new position size

          // Check if the computed quantity is valid
          if (qty < 0.0001) {
            const msg = `[ENTER_BUY] Computed quantity ${qty} is too small for ${symbol}. Skipping reversal.`;
            console.log(msg);
            await sendEmail("Qty Too Small - Skipped Reversal", msg);
            return { status: "skipped", reason: "qty_too_small" };
          }

          // Open a new long position
          const buyResult = await futuresMarketBuy(symbol, qty);

          // Extract the entry price for the new long position
          const newFillPrice = parseFloat(buyResult.avgPrice);
          const executedQty = parseFloat(buyResult.executedQty);
          const costUsdt = (newFillPrice * executedQty) / LEVERAGE;

          const newBal = usdtBal - costUsdt;
          // await updateUsdtBalance(newBal);

          // Update the "positions" node in Firebase with the new long position details
          await updatePosition(symbol, {
            side: "BUY",
            size: executedQty,
            entryPrice: newFillPrice,
            leverage: LEVERAGE,
            capitalAllocated: costUsdt,
            updatedAt: Date.now(),
            openedAt: Date.now(),
          });

          // Send an email notification about the reversal
          const emailMsg = `Reversed position to BUY for ${symbol}:
          - Closed Short Qty: ${closeQty}
          - Fill Price: ${newFillPrice}
          - Realized PnL: ${realizedPnL.toFixed(2)}
          - Opened Long Qty: ${qty}
          - New Entry Price: ${newFillPrice}
          -BALANCE: ${newBal}`;
          await sendEmail(`Reversal to BUY - ${symbol}`, emailMsg);

          // Return success response
          return {
            status: "success",
            action: "reversed_to_buy",
            qty,
            newFillPrice,
            realizedPnL,
          };
        }

        // ----------------------------------------
        // Skip if Already in a BUY Position
        // ----------------------------------------
        if (position && position.side === "BUY") {
          console.log(
            `[ENTER_BUY] Already in a BUY position for ${symbol}. Skipping.`
          );
          return { status: "skip_already_in_buy_position" };
        }

        // ----------------------------------------
        // Normal BUY Operation
        // ----------------------------------------

        // Fetch available USDT balance
        const usdtBal = await getUsdtBalance();

        // Check if balance is sufficient
        if (usdtBal < 5) {
          const msg = `[ENTER_BUY] Balance is only ${usdtBal}, too low for ${symbol}.`;
          console.log(msg);
          await sendEmail("Low Balance - Skipped ENTER_BUY", msg);
          return { status: "no_trade", reason: "low_balance" };
        }

        // Use a portion of the balance to compute the quantity for the BUY
        const spendUsdt = usdtBal * 0.5; // Use 25% of balance
        const qty = await computeQty(spendUsdt, symbol);

        // Check if the computed quantity is valid
        if (qty < 0.0001) {
          const msg = `[ENTER_BUY] Computed quantity ${qty} is too small for ${symbol}.`;
          console.log(msg);
          await sendEmail("Qty Too Small - Skipped ENTER_BUY", msg);
          return { status: "skipped", reason: "qty_too_small" };
        }

        // Open a new long position
        const buyResult = await futuresMarketBuy(symbol, qty);

        // Extract the entry price for the new long position
        const FillPrice = parseFloat(buyResult.avgPrice);
        const executedQty = parseFloat(buyResult.executedQty);
        const costUsdt = (FillPrice * executedQty) / LEVERAGE;

        const newBal = usdtBal - costUsdt;
        // await updateUsdtBalance(newBal);

        // Update the "positions" node in Firebase with the new long position details
        await updatePosition(symbol, {
          side: "BUY",
          size: executedQty,
          entryPrice: FillPrice,
          leverage: LEVERAGE,
          capitalAllocated: costUsdt,
          updatedAt: Date.now(),
          openedAt: Date.now(),
        });

        // Send an email notification about the new BUY
        const emailMsg = `ENTER_BUY executed for ${symbol}:
        - Quantity: ${qty}
        - Fill Price: ${FillPrice}
        - Cost: ${costUsdt}`;
        await sendEmail(`ENTER_BUY - ${symbol}`, emailMsg);

        // Return success response
        return {
          status: "success",
          action: "ENTER_BUY",
          qty,
          FillPrice,
          costUsdt,
        };
      }

      // ----------------------------------------
      // ENTER_SELL
      // ----------------------------------------
      case "sell": {
        // ----------------------------------------
        // Reverse a Long Position to Short
        // ----------------------------------------
        if (position && position.side === "BUY" && position.size > 0) {
          const closeQty = position.size; // Quantity of the long position to close
          console.log(
            `[SELL] Reversing long position for ${symbol}. Qty=${closeQty}`
          );

          // Close the existing long position
          const closeResult = await futuresMarketSell(symbol, closeQty);

          // Extract the fill price for the closed position
          const fillPrice = parseFloat(closeResult.avgPrice); // Average price of executed order
          const executedQty = parseFloat(closeResult.executedQty);

          // Compute realized PnL for the closed long position
          const realizedPnL = (fillPrice - position.entryPrice) * executedQty;

          // Move the closed position to "past_positions" in Firebase
          await moveToPastPositions(symbol, {
            ...position, // Include existing position details
            exitPrice: fillPrice, // Price at which the position was closed
            realizedPnL, // Realized profit/loss from the trade
            closedAt: Date.now(), // Timestamp of position closure
          });

          // Fetch available USDT balance
          const usdtBal = await getUsdtBalance();

          console.log(
            `[SELL] Long position closed for ${symbol}. Now opening a short position.`
          );

          // Use a portion of the balance to compute the quantity for the new short position
          const spendUsdt = usdtBal * 0.5; // Use 50% of the available balance
          const qty = await computeQty(spendUsdt, symbol); // Compute the new position size

          // Check if the computed quantity is valid
          if (qty < 0.0001) {
            const msg = `[ENTER_SELL] Computed quantity ${qty} is too small for ${symbol}. Skipping reversal.`;
            console.log(msg);
            await sendEmail("Qty Too Small - Skipped Reversal", msg);
            return { status: "skipped", reason: "qty_too_small" };
          }

          // Open a new short position
          const sellResult = await futuresMarketSell(symbol, qty);

          // Extract the entry price for the new short position
          const newFillPrice = parseFloat(sellResult.avgPrice);
          const executedSellQty = parseFloat(sellResult.executedQty);
          const costUsdt = (newFillPrice * executedSellQty) / LEVERAGE;

          const newBal = usdtBal - costUsdt;
          // await updateUsdtBalance(newBal);

          // Update the "positions" node in Firebase with the new short position details
          await updatePosition(symbol, {
            side: "SELL",
            size: executedSellQty,
            entryPrice: newFillPrice,
            leverage: LEVERAGE,
            capitalAllocated: costUsdt,
            updatedAt: Date.now(),
            openedAt: Date.now(),
          });

          // Send an email notification about the reversal
          const emailMsg = `Reversed position to SELL for ${symbol}:
          - Closed Long Qty: ${closeQty}
          - Fill Price: ${newFillPrice}
          - Realized PnL: ${realizedPnL.toFixed(2)}
          - Opened Short Qty: ${executedSellQty}
          - New Entry Price: ${newFillPrice}
          - BALANCE: ${newBal}`;
          await sendEmail(`Reversal to SELL - ${symbol}`, emailMsg);

          // Return success response
          return {
            status: "success",
            action: "reversed_to_sell",
            qty: executedSellQty,
            newFillPrice,
            realizedPnL,
          };
        }

        // ----------------------------------------
        // Skip if Already in a SELL Position
        // ----------------------------------------
        if (position && position.side === "SELL") {
          console.log(
            `[ENTER_SELL] Already in a SELL position for ${symbol}. Skipping.`
          );
          return { status: "skip_already_in_sell_position" };
        }

        // ----------------------------------------
        // Normal SELL Operation
        // ----------------------------------------
        // Fetch available USDT balance
        const usdtBal = await getUsdtBalance();

        // Check if balance is sufficient
        if (usdtBal < 5) {
          const msg = `[ENTER_SELL] Balance is only ${usdtBal}, too low for ${symbol}.`;
          console.log(msg);
          await sendEmail("Low Balance - Skipped ENTER_SELL", msg);
          return { status: "no_trade", reason: "low_balance" };
        }

        // Use a portion of the balance to compute the quantity for the SELL
        const spendUsdt = usdtBal * 0.5; // Use 50% of the available balance
        const qty = await computeQty(spendUsdt, symbol);

        // Check if the computed quantity is valid
        if (qty < 0.0001) {
          const msg = `[ENTER_SELL] Computed quantity ${qty} is too small for ${symbol}.`;
          console.log(msg);
          await sendEmail("Qty Too Small - Skipped ENTER_SELL", msg);
          return { status: "skipped", reason: "qty_too_small" };
        }

        // Open a new short position
        const sellResult = await futuresMarketSell(symbol, qty);

        // Extract the entry price for the new short position
        const fillPrice = parseFloat(sellResult.avgPrice);
        const executedQty = parseFloat(sellResult.executedQty);
        const costUsdt = (fillPrice * executedQty) / LEVERAGE;

        const newBal = usdtBal - costUsdt;
        // await updateUsdtBalance(newBal);

        // Update the "positions" node in Firebase with the new short position details
        await updatePosition(symbol, {
          side: "SELL",
          size: executedQty,
          entryPrice: fillPrice,
          leverage: 30,
          capitalAllocated: costUsdt,
          updatedAt: Date.now(),
          openedAt: Date.now(),
        });

        // Send an email notification about the new SELL
        const emailMsg = `ENTER_SELL executed for ${symbol}:
        - Quantity: ${executedQty}
        - Fill Price: ${fillPrice}
        - Cost: ${costUsdt}
        - BALANCE: ${newBal}`;
        await sendEmail(`ENTER_SELL - ${symbol}`, emailMsg);

        // Return success response
        return {
          status: "success",
          action: "ENTER_SELL",
          qty: executedQty,
          fillPrice,
          costUsdt,
        };
      }

      default:
        console.log(`[ProcessSignals] Unknown type: ${type}`);
        return { status: "error", message: `Unknown type: ${type}` };
    }
  } catch (err) {
    console.error("[ProcessSignals] Error:", err);
    throw err;
  }
};

// -------------------------------------------------------------------------------------
// 8) Worker Listener
// -------------------------------------------------------------------------------------
if (parentPort) {
  ProcessSignals(workerData)
    .then((result) => parentPort.postMessage({ result }))
    .catch((error) => parentPort.postMessage({ error: error.message }));
}
