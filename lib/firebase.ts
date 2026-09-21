import { getApp, getApps, initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore, initializeFirestore, persistentLocalCache, persistentMultipleTabManager } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyB9QBN2Iv70LaFSC6mxP15bsyG1ldEP65c",
  authDomain: "split-app-1b50e.firebaseapp.com",
  projectId: "split-app-1b50e",
  storageBucket: "split-app-1b50e.firebasestorage.app",
  messagingSenderId: "84653163240",
  appId: "1:84653163240:web:aa3d35ecbd06eafe253f5d",
};

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = (() => {
  try {
    return initializeFirestore(app, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
    });
  } catch {
    return getFirestore(app);
  }
})();
