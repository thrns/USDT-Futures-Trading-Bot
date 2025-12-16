# Binance USDT Futures Trading Bot

This project is an automated trading bot designed to process trading signals and execute trades on Binance USDT Futures. It integrates with Firebase for real-time data management, employs technical indicators to validate signals, and sends email notifications to monitor trading activities and errors. Built with Node.js, this bot demonstrates proficiency in asynchronous programming, API integration, and financial technology.

## Features

- **Automated Trading:** Processes up to 8 simultaneous trading signals, executing buy and sell orders on Binance USDT Futures.
- **Real-Time Data Management:** Uses Firebase Realtime Database to store and update position data and USDT account balance.
- **Signal Validation:** Validates trading signals with technical indicators (ADX, ATR, RSI) to minimize false positives and enhance decision-making.
- **Market Order Execution:** Places immediate market buy and sell orders via the Binance Futures API.
- **Email Notifications:** Sends alerts for successful trades, errors, and critical events using Nodemailer.
- **Robust Error Handling:** Ensures graceful handling of exceptions to maintain operational stability.

## Technologies Used

- **Node.js:** Core scripting language for implementing the bot's logic.
- **Binance API:** Facilitates interaction with Binance USDT Futures for trade execution and price retrieval.
- **Firebase Realtime Database:** Manages position data and account balance in real time.
- **Technical Indicators:** 
  - **ADX (Average Directional Index):** Assesses trend strength.
  - **ATR (Average True Range):** Measures volatility.
  - **RSI (Relative Strength Index):** Evaluates overbought/oversold conditions.
- **Nodemailer:** Enables email notifications for monitoring and alerts.
- **JavaScript Promises and Async/Await:** Handles asynchronous operations for seamless API and database interactions.

## How It Works

The trading bot operates as follows:

1. **Signal Reception:** Receives trading signals containing a coin symbol (e.g., `BTCUSDT`) and action type (`buy` or `sell`).
2. **Position Check:** 
   - For `buy` signals, verifies if a position exists for the coin. If none, proceeds to validation.
   - For `sell` signals, confirms an existing position before proceeding.
3. **Signal Validation:** Applies ADX, ATR, and RSI indicators to validate `buy` signals, ensuring reliability.
4. **Trade Calculation:** Calculates trade quantity based on the available USDT balance and current market price.
5. **Trade Execution:** 
   - Executes a market buy or sell order on Binance USDT Futures.
   - Updates position data and USDT balance in Firebase.
6. **Notifications:** Sends email notifications for trade confirmations or errors.

## Usage

The bot runs continuously, processing incoming trading signals. Signals can be provided via an external script or service that invokes the `ProcessSignals` function with data in the format `{ coin: "BTCUSDT", type: "buy" }` or `{ coin: "BTCUSDT", type: "sell" }`.

## Project Highlights

This project showcases the following technical skills and accomplishments:

- **API Integration:** Seamless interaction with Binance Futures API for real-time trading.
- **Database Management:** Efficient use of Firebase for persistent data storage and updates.
- **Financial Analysis:** Application of technical indicators to inform trading decisions.
- **Asynchronous Programming:** Robust handling of concurrent operations using Promises and async/await.
- **Notification System:** Implementation of an email-based monitoring system for operational transparency.

## Disclaimer

This trading bot is developed for **educational and demonstration purposes only**. It is not intended for live trading without extensive testing and risk assessment. The author is not liable for any financial losses resulting from its use.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
