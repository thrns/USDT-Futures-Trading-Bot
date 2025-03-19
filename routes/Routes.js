import express from 'express';
import { Worker } from 'worker_threads';

const router = express.Router();

const runWorker = (workerFile, data) => {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerFile, { workerData: data });

    worker.on('message', (message) => {
      if (message.error) {
        reject(new Error(message.error));
      } else {
        resolve(message.result);
      }
    });

    worker.on('error', reject);
    worker.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`Worker stopped with exit code ${code}`));
      }
    });
  });
};

router.get('/test', (req, res) => {
  res.send('Test route "...API/TEST" is working!');
});

router.post('/webhook', async (req, res) => {
  try {
    const result = await runWorker('./functions/ProcessSignals.js', req.body);
    console.log('Worker result:', result);
    res.status(200).json({ success: true, result });
  } catch (error) {
    console.error('Error in ProcessSignals:', error.message);
    res.status(500).json({
      success: false,
      error: error.message || 'An error occurred while processing the webhook.',
    });
  }
});

export default router;
