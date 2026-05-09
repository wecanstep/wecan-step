import {
  auth,
  db,
  collection,
  addDoc,
  serverTimestamp,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  normalizePhone,
  firebaseErrorMessage
} from "./firebase-wecan.js";

function showFieldError(input, errId, msg) {
  if (!input) return;
  input.classList.add("error");
  input.classList.remove("success");
  const err = document.getElementById(errId);
  if (err) {
    const last = err.querySelector("span:last-child");
    if (last) last.textContent = msg;
    err.classList.add("show");
  }
}

function setFieldOk(input) {
  if (!input) return;
  input.classList.remove("error");
  input.classList.add("success");
}

function showMainToast(msg) {
  const toast = document.getElementById("mainToast");
  const tMsg = document.getElementById("toastMsg");
  if (tMsg) tMsg.textContent = msg;
  if (toast) toast.classList.add("show");
}

function buildWhatsappLink(name, phone, email) {
  let msg = "السلام عليكم، أرسلت طلب اشتراك في منصة WE CAN STEP وأرغب في تفعيل حسابي";
  if (name) msg += "\nالاسم: " + name;
  if (phone) msg += "\nالجوال: " + phone;
  if (email) msg += "\nالإيميل: " + email;
  return "https://wa.me/966578335848?text=" + encodeURIComponent(msg);
}

window.addEventListener("DOMContentLoaded", function () {
  const form = document.getElementById("reqForm");
  if (!form) return;

  form.addEventListener("submit", async function (e) {
    e.preventDefault();
    e.stopImmediatePropagation();

    const toast = document.getElementById("mainToast");
    if (toast) toast.classList.remove("show");

    const rName = document.getElementById("rName");
    const rPhone = document.getElementById("rPhone");
    const rEmail = document.getElementById("rEmail");
    const rPw = document.getElementById("rPassword");
    const btn = document.getElementById("submitBtn");

    const name = (rName?.value || "").trim();
    const phone = normalizePhone(rPhone?.value || "");
    const email = (rEmail?.value || "").trim().toLowerCase();
    const pw = (rPw?.value || "").trim();

    let valid = true;
    if (!name || name.split(/\s+/).filter(Boolean).length < 4) { showFieldError(rName, "nameErr", "الاسم الرباعي مطلوب (4 كلمات على الأقل)"); valid = false; } else setFieldOk(rName);
    if (!/^05\d{8}$/.test(phone)) { showFieldError(rPhone, "phoneErr", "رقم جوال غير صحيح (يبدأ بـ 05)"); valid = false; } else setFieldOk(rPhone);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showFieldError(rEmail, "emailErr", "بريد إلكتروني غير صحيح"); valid = false; } else setFieldOk(rEmail);
    if (pw.length < 6) { showFieldError(rPw, "pwErr", "كلمة المرور 6 أحرف على الأقل"); valid = false; } else setFieldOk(rPw);
    if (!valid) return;

    if (btn) {
      btn.disabled = true;
      btn.textContent = "جارٍ إرسال الطلب...";
    }

    try {
      let uid = "";
      try {
        const cred = await createUserWithEmailAndPassword(auth, email, pw);
        uid = cred.user.uid;
      } catch (err) {
        if (err && err.code === "auth/email-already-in-use") {
          const cred = await signInWithEmailAndPassword(auth, email, pw);
          uid = cred.user.uid;
        } else {
          throw err;
        }
      }

      await addDoc(collection(db, "subscriptionRequests"), {
        uid,
        name,
        phone,
        email,
        status: "pending",
        source: "website",
        createdAt: serverTimestamp(),
        createdAtMs: Date.now()
      });

      try { await signOut(auth); } catch (_) {}

      const formSection = document.getElementById("formSection");
      const successSection = document.getElementById("successSection");
      const waBtn = document.getElementById("waBtn");
      if (formSection) formSection.style.display = "none";
      if (successSection) successSection.style.display = "block";
      if (waBtn) waBtn.href = buildWhatsappLink(name, phone, email);
    } catch (err) {
      showMainToast(firebaseErrorMessage(err));
      if (btn) {
        btn.disabled = false;
        btn.textContent = "🎓 أرسل طلب الاشتراك ←";
      }
    }
  }, true);
});
