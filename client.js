import { initializeApp } from 'firebase/app';
import { getDatabase } from 'firebase/database';

const firebaseConfig = {};

const ATApp = initializeApp(firebaseConfig);
export const ATRealDb = getDatabase(ATApp);
