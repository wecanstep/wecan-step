import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-app.js";
import {
  getFirestore,
  collection,
  addDoc,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  query,
  orderBy,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.12.1/firebase-firestore.js";
import {
  getAuth,
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  setPersistence,
  browserLocalPersistence,
  browserSessionPersistence
} from "https://www.gstatic.com/firebasejs/12.12.1/firebase-auth.js";

export const firebaseConfig = {
  apiKey: "AIzaSyBXLmS5Wtp-euCp5wDyT6X6AqRUJ9TeDxo",
  authDomain: "wecan-step-platform.firebaseapp.com",
  projectId: "wecan-step-platform",
  storageBucket: "wecan-step-platform.firebasestorage.app",
  messagingSenderId: "237780054765",
  appId: "1:237780054765:web:908c9f93dd4184a783d2e4"
};

export const app = getApps().some(a => a.name === "[DEFAULT]") ? getApp() : initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);

export const secondaryApp = getApps().some(a => a.name === "wecanSecondary")
  ? getApp("wecanSecondary")
  : initializeApp(firebaseConfig, "wecanSecondary");
export const secondaryAuth = getAuth(secondaryApp);

export {
  collection,
  addDoc,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  query,
  orderBy,
  serverTimestamp,
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  setPersistence,
  browserLocalPersistence,
  browserSessionPersistence
};

export const ADMIN_EMAIL = "support@wecan4step.com";

export function emailKey(email) {
  return String(email || "").trim().toLowerCase().replace(/\//g, "_");
}

export function normalizePhone(phone) {
  return String(phone || "").replace(/\D/g, "");
}

export function firebaseErrorMessage(err) {
  const code = err && err.code ? err.code : "";
  if (code === "auth/email-already-in-use") return "هذا البريد مسجل مسبقًا. جرّب تسجيل الدخول أو استخدم بريدًا آخر.";
  if (code === "auth/invalid-email") return "البريد الإلكتروني غير صحيح.";
  if (code === "auth/weak-password") return "كلمة المرور ضعيفة. استخدم 6 أحرف على الأقل.";
  if (code === "auth/user-not-found" || code === "auth/invalid-credential" || code === "auth/wrong-password") return "بيانات الدخول غير صحيحة.";
  if (code === "permission-denied") return "صلاحيات Firebase غير مفعّلة بشكل صحيح. راجع قواعد Firestore.";
  if (code === "failed-precondition") return "Firestore يحتاج إعداد أو فهرس. تأكد من إنشاء قاعدة البيانات.";
  return (err && err.message) ? err.message : "حدث خطأ غير متوقع.";
}
