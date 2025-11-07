// Firebase Configuration and Authentication Module
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import { 
    getAuth, 
    signInWithEmailAndPassword, 
    signOut, 
    onAuthStateChanged,
    setPersistence,
    browserLocalPersistence,
    browserSessionPersistence
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import { 
    getFirestore,
    doc,
    getDoc,
    setDoc,
    updateDoc,
    collection,
    query,
    where,
    getDocs
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";

// Your web app's Firebase configuration
const firebaseConfig = {
    apiKey: "AIzaSyAXQNraHTsDcw3j7da1hlCIzMNT8NW-rGc",
    authDomain: "blue-chip-signals-log-ins.firebaseapp.com",
    projectId: "blue-chip-signals-log-ins",
    storageBucket: "blue-chip-signals-log-ins.firebasestorage.app",
    messagingSenderId: "706921883505",
    appId: "1:706921883505:web:230d622a5c0d2e341378d0"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// Export auth instance and functions
export { 
    auth,
    db,
    signInWithEmailAndPassword, 
    signOut, 
    onAuthStateChanged,
    setPersistence,
    browserLocalPersistence,
    browserSessionPersistence,
    doc,
    getDoc,
    setDoc,
    updateDoc,
    collection,
    query,
    where,
    getDocs
};

