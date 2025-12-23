
  import { initializeApp } from "firebase/app";
// import { getAuth, updateProfile } from "firebase/auth";
// import { getFirestore } from "firebase/firestore";
import { getDatabase } from "firebase/database";

const firebaseConfig = {

  };



// Initialize Firebase
const ATApp = initializeApp(firebaseConfig);
// const SSAuth = getAuth(SSApp);
// const SSdb = getFirestore(SSApp);
export const ATRealDb =getDatabase(ATApp);


