import {
  auth,
  db,
  doc,
  getDoc,
  setDoc,
  serverTimestamp,
  signInWithEmailAndPassword,
  setPersistence,
  browserLocalPersistence,
  browserSessionPersistence,
  onAuthStateChanged,
  ADMIN_EMAIL,
  emailKey,
  normalizePhone,
  firebaseErrorMessage
} from "./firebase-wecan.js";

function showLoginError(input, errEl, msg) {
  if (input) {
    input.classList.add("error");
    input.classList.remove("success");
  }
  if (errEl) {
    const last = errEl.querySelector("span:last-child");
    if (last) last.textContent = msg;
    errEl.classList.add("show");
  }
}

function setOk(input) {
  if (input) {
    input.classList.remove("error");
    input.classList.add("success");
  }
}

function showToastMsg(msg) {
  const toast = document.getElementById("mainToast");
  const toastMsg = document.getElementById("toastMsg");
  if (toastMsg) toastMsg.textContent = msg;
  if (toast) toast.classList.add("show");
}

async function resolveEmail(identifier) {
  const id = String(identifier || "").trim().toLowerCase();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(id)) return id;
  const phone = normalizePhone(id);
  if (/^05\d{8}$/.test(phone)) {
    const snap = await getDoc(doc(db, "phoneLookup", phone));
    if (snap.exists() && snap.data().email) return String(snap.data().email).toLowerCase();
  }
  return "";
}
async function cacheAndRouteStudent(email, fallbackName = "", fallbackPhone = "") {
  const studentSnap = await getDoc(doc(db, "students", emailKey(email)));
  const student = studentSnap.exists() ? studentSnap.data() : null;
  const expiresMs = Number((student && student.subscriptionExpiresAtMs) || 0);
  const isExpired = !!expiresMs && expiresMs < Date.now();
  const isSubscriber = !!(student && student.isSubscriber === true && !isExpired);
  const name = (student && student.name) || fallbackName || "";
  const phone = (student && student.phone) || fallbackPhone || "";

  try {
    localStorage.setItem("isLoggedIn", "true");
    localStorage.setItem("userName", name);
    localStorage.setItem("userPhone", phone);
    localStorage.setItem("userEmail", email);
    localStorage.setItem("visitorLoggedIn", "true");
    localStorage.setItem("visitorName", name);
    localStorage.setItem("visitorPhone", phone);
    localStorage.setItem("visitorEmail", email);
    localStorage.setItem("isSubscriber", isSubscriber ? "true" : "false");
    localStorage.setItem("subscriptionExpiresAtMs", expiresMs ? String(expiresMs) : "");
  } catch (_) {}

  if (isExpired) {
    showToastMsg("انتهى اشتراكك. تواصل معنا لتجديد الاشتراك.");
    return "free-dashboard.html?subscription=expired";
  }
  return isSubscriber ? "students.html" : "free-dashboard.html";
}

function setLoadingMessage(msg) {
  const btn = document.getElementById("submitBtn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = msg;
  }
}

window.addEventListener("DOMContentLoaded", function () {
  const form = document.getElementById("loginForm");
  if (!form) return;

  const remember = document.getElementById("rememberMe");
  try {
    const saved = localStorage.getItem("wcsRememberMe");
    if (remember) remember.checked = saved !== "false";
  } catch (_) {
    if (remember) remember.checked = true;
  }

  // إذا كان الطالب مسجل دخول سابقًا من نفس الجهاز، ادخله مباشرة بدون إعادة كتابة البيانات.
  onAuthStateChanged(auth, async function(user) {
    try {
      if (!user || !user.email) return;
      const email = String(user.email).toLowerCase();
      setLoadingMessage("جاري التحقق من اشتراكك...");
      if (email === ADMIN_EMAIL) {
        try { localStorage.setItem("isAdmin", "true"); } catch(_) {}
        window.location.replace("admin.html");
        return;
      }
      const next = await cacheAndRouteStudent(email, user.displayName || "", "");
      window.location.replace(next);
    } catch (_) {
      const btn = document.getElementById("submitBtn");
      if (btn) {
        btn.disabled = false;
        btn.textContent = "تسجيل الدخول ←";
      }
    }
  });

  form.addEventListener("submit", async function (e) {
    e.preventDefault();
    e.stopImmediatePropagation();

    const idInput = document.getElementById("identifier");
    const pwInput = document.getElementById("password");
    const idErr = document.getElementById("identifierError");
    const pwErr = document.getElementById("passwordError");
    const btn = document.getElementById("submitBtn");

    const id = (idInput?.value || "").trim();
    const pw = (pwInput?.value || "").trim();

    let valid = true;
    if (!id) { showLoginError(idInput, idErr, "يرجى إدخال رقم الجوال أو البريد الإلكتروني"); valid = false; } else setOk(idInput);
    if (!pw) { showLoginError(pwInput, pwErr, "يرجى إدخال كلمة المرور"); valid = false; } else setOk(pwInput);
    if (!valid) return;

    if (btn) {
      btn.disabled = true;
      btn.textContent = "جارٍ الدخول...";
    }

    try {
      const rememberMe = document.getElementById("rememberMe")?.checked !== false;
      try { localStorage.setItem("wcsRememberMe", rememberMe ? "true" : "false"); } catch (_) {}
      await setPersistence(auth, rememberMe ? browserLocalPersistence : browserSessionPersistence);

      if (id.toLowerCase() === ADMIN_EMAIL) {
        await signInWithEmailAndPassword(auth, ADMIN_EMAIL, pw);
        localStorage.setItem("isAdmin", "true");
        window.location.href = "admin.html";
        return;
      }

      const email = await resolveEmail(id);
      if (!email) throw new Error("لم يتم العثور على حساب بهذا الجوال أو البريد.");

      const cred = await signInWithEmailAndPassword(auth, email, pw);
      const next = await cacheAndRouteStudent(email, cred.user.displayName || "", normalizePhone(id));

      // تحديث آخر دخول للطالب. إذا لم تسمح القواعد الحالية بذلك، يتم تجاهله بدون تعطيل الدخول.
      try {
        await setDoc(doc(db, "students", emailKey(email)), {
          lastLoginAt: serverTimestamp(),
          lastLoginAtMs: Date.now()
        }, { merge: true });
      } catch (_) {}

      window.location.href = next;
    } catch (err) {
      showToastMsg(firebaseErrorMessage(err));
      showLoginError(idInput, idErr, "تحقق من رقم الجوال أو البريد الإلكتروني");
      showLoginError(pwInput, pwErr, "تحقق من كلمة المرور");
      if (btn) {
        btn.disabled = false;
        btn.textContent = "تسجيل الدخول";
      }
    }
  }, true);
});
