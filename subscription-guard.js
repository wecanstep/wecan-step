import {
  auth,
  db,
  doc,
  getDoc,
  onAuthStateChanged,
  ADMIN_EMAIL,
  emailKey
} from "./firebase-wecan.js";

function revealPage() {
  try {
    const blocker = document.getElementById("wcs-auth-hide");
    if (blocker) blocker.remove();
    document.documentElement.classList.add("wcs-auth-ready");
    if (document.body) document.body.style.visibility = "";
  } catch (_) {}
}

function clearSubscriberSession() {
  try {
    localStorage.removeItem("isLoggedIn");
    localStorage.removeItem("isSubscriber");
    localStorage.removeItem("subscriptionExpiresAtMs");
    localStorage.removeItem("visitorLoggedIn");
  } catch (_) {}
}

function allowFreeRedirect() {
  const path = location.pathname.split("/").pop() || "index.html";
  const freePages = [
    "index.html", "login.html", "signup.html", "free-dashboard.html",
    "free-reading.html", "free-grammar.html", "free-listening.html",
    "free-tips.html", "subscriber-request.html", "step-test.html"
  ];
  return freePages.includes(path) || path.startsWith("free-");
}

function isExpired(student) {
  const exp = Number(student?.subscriptionExpiresAtMs || 0);
  return !!exp && exp < Date.now();
}

onAuthStateChanged(auth, async function(user) {
  try {
    if (!user || !user.email) {
      if (!allowFreeRedirect()) {
        clearSubscriberSession();
        window.location.replace("./login.html");
        return;
      }
      revealPage();
      return;
    }

    const email = String(user.email).toLowerCase();

    // الأدمن لا يحصل على صلاحية طالب تلقائيًا للصفحات المدفوعة.
    if (email === ADMIN_EMAIL) {
      if (!allowFreeRedirect()) {
        window.location.replace("./admin.html");
        return;
      }
      revealPage();
      return;
    }

    const snap = await getDoc(doc(db, "students", emailKey(email)));
    const student = snap.exists() ? snap.data() : null;
    const active = !!(student && student.isSubscriber === true && !isExpired(student));

    try {
      localStorage.setItem("isLoggedIn", "true");
      localStorage.setItem("userEmail", email);
      localStorage.setItem("isSubscriber", active ? "true" : "false");
      if (student?.name) localStorage.setItem("userName", student.name);
      if (student?.phone) localStorage.setItem("userPhone", student.phone);
      if (student?.subscriptionExpiresAtMs) {
        localStorage.setItem("subscriptionExpiresAtMs", String(student.subscriptionExpiresAtMs));
      } else {
        localStorage.removeItem("subscriptionExpiresAtMs");
      }
    } catch (_) {}

    if (!active && !allowFreeRedirect()) {
      clearSubscriberSession();
      window.location.replace("./free-dashboard.html?subscription=expired");
      return;
    }

    revealPage();
  } catch (_) {
    if (!allowFreeRedirect()) {
      clearSubscriberSession();
      window.location.replace("./login.html");
      return;
    }
    revealPage();
  }
});
