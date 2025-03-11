import express from 'express';
import dotenv from 'dotenv-esm';
import cors from 'cors';
import bodyParser from 'body-parser';

import router from './routes/Routes.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5002;

app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ limit: '10mb', extended: true }));
app.use(cors());
app.use('/api', router);

app.get('/', (req, res) => {
  res.send('Hello from bentolink :D');
});

app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

app.listen(PORT, () => {
  console.log('App listening at port', PORT);
});
