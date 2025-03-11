import express from 'express';

const router = express.Router();

router.get('/test', (req, res) => {
  res.send('Test route "...API/TEST" is working!');
});

router.post('/webhook', (req, res) => {
  res.status(202).json({ accepted: true, signal: req.body });
});

export default router;
