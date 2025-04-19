
async function computeQty(spendUsdt, symbol) {
    console.log("symbol: ", symbol);
    const lastPrice = await getLastPrice(symbol);
    if (!lastPrice || lastPrice <= 0) {
     `console.error([computeQty] Invalid last price: ${lastPrice})`
      return 0;
    }
  
    const precision = await getSymbolPrecision(symbol);
    const rawQty = spendUsdt / lastPrice;
    const roundedQty = parseFloat(
      rawQty.toFixed(precision.quantityPrecision)
    );
  
    if (roundedQty <= 0) {
      console.error(
        `[computeQty] Computed quantity too small: ${roundedQty}`
      );
      return 0;
    }
  
    return roundedQty;
  }
  
  // -------------------------------------------------------------------------------------
  // 7) Main: ProcessSignals
  //     We handle these 2 signals from TTR: buy and sell
  //     if sell in uptrend, we take profit 50% of margin
  //     if buy in uptrend, we enter long
  //     if sell in downtrend, we enter short
  //     if buy in downtrend, we take profit 50% of margin
  // -------------------------------------------------------------------------------------
  const ProcessSignals = async (reqData) => {
    try {
      const { coin, type } = reqData;
      const refinedCoin = coin.split(".")[0];
  
      if (!refinedCoin || !type) {
        const msg = "ProcessSignals Error: Missing coin or type in workerData.";
        console.error(msg);
        await sendEmail("ProcessSignals Data Error", msg);
        throw new Error(msg);
      }
  
  
  
  
      const position = await getPosition(refinedCoin);
      const symbol = getSymbol(refinedCoin);
      const usdtBal = await getUsdtBalance();
  
      if (usdtBal < 5) {
        const msg = `Balance too low (${usdtBal} USDT) for ${refinedCoin}. Skipping trade.`;
        console.log(msg);
        await sendEmail("Low Balance", msg);
        return { status: "skipped", reason: "low_balance", usdtBal };
      }
  
      const isUptrend = await determineTrend(symbol); // True for uptrend, false for downtrend
  
      if (type === "buy") {
        if (isUptrend) {
          if (!position.side || position.side !== "BUY") {
            return await executeEnter(symbol, "BUY", usdtBal);
          } else {
            return await executeTakeProfit(symbol, "SELL", position);
          }
        } else {
          return await executeTakeProfit(symbol, "SELL", position);
        }
      } else if (type === "sell") {
        if (isUptrend) {
          return await executeTakeProfit(symbol, "BUY", position);
        } else {
          if (!position.side || position.side !== "SELL") {
            return await executeEnter(symbol, "SELL", usdtBal);
          }
        }
      }
  
      return { status: "no_action", message: "No action taken based on conditions." };
    } catch (err) {
      console.error("[ProcessSignals] Error:", err);
      throw err;
    }
  };
  
  // Helper functions
  
  async function determineTrend(symbol) {
    try {
      const candles = await client.getKlines({ symbol, interval: "15m", limit: 50 });
      if (!candles || candles.length < 30) {
        throw new Error(`Not enough candles to determine trend for ${symbol}`);
      }
  
      const highArray = candles.map((c) => parseFloat(c[2]));
      const lowArray = candles.map((c) => parseFloat(c[3]));
      const closeArray = candles.map((c) => parseFloat(c[4]));
  
      const adxValue = ADX.calculate({ high: highArray, low: lowArray, close: closeArray, period: 14 }).pop()?.adx || 0;
      const rsiValue = RSI.calculate({ values: closeArray, period: 14 }).pop() || 0;
  
      return adxValue > 25 && rsiValue > 50; // Example conditions for uptrend
    } catch (err) {
      console.error(`[determineTrend] Error: ${err.message}`);
      return false; // Assume downtrend if error
    }
  }
  
  async function executeEnter(symbol, side, balance) {
    const spendUsdt = balance * 0.25; // Use 25% of balance
    const qty = await computeQty(spendUsdt, symbol);
    if (qty < 0.0001) throw new Error("Computed quantity too small.");
  
    const orderFn = side === "BUY" ? futuresMarketBuy : futuresMarketSell;
    const result = await orderFn(symbol, qty);
    const fillPrice = parseFloat(result.fills[0]?.price || 0);
    const cost = qty * fillPrice;
  
    const newBal = balance - cost;
    await updateUsdtBalance(newBal);
    await updatePosition(symbol, { side, size: qty, entryPrice: fillPrice });
  
    await sendEmail(`ENTER_${side} - ${symbol}`, `Executed ENTER_${side} for ${symbol}:
      - Quantity: ${qty}
      - Fill Price: ${fillPrice}
      - Cost: ${cost}
      - Updated Balance: ${newBal}`);
    return { status: "success", action: `ENTER_${side}`, qty, fillPrice, newBal };
  }
  
  async function executeTakeProfit(symbol, side, position) {
    const partialQty = position.size * 0.5; // Take 50% profit
    if (partialQty < 0.0001) throw new Error("Computed quantity too small.");
  
    const orderFn = side === "BUY" ? futuresMarketBuy : futuresMarketSell;
    const result = await orderFn(symbol, partialQty);
    const fillPrice = parseFloat(result.fills[0]?.price || 0);
    const proceeds = partialQty * fillPrice;
  
    const newSize = position.size - partialQty;
    const newBal = (await getUsdtBalance()) + proceeds;
    await updateUsdtBalance(newBal);
    await updatePosition(symbol, { size: newSize });
  
    await sendEmail(`TP_${side} - ${symbol}`, `Partial TP_${side} for ${symbol}:
      - Quantity: ${partialQty}
      - Fill Price: ${fillPrice}
      - Proceeds: ${proceeds}
      - Updated Position Size: ${newSize}
      - Updated Balance: ${newBal}`);
    return { status: "success", action: `TP_${side}`, partialQty, newSize, newBal };
  }
  