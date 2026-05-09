import {
  auth,
  db,
  secondaryAuth,
  ADMIN_EMAIL,
  onAuthStateChanged,
  collection,
  doc,
  getDocs,
  setDoc,
  updateDoc,
  query,
  orderBy,
  serverTimestamp,
  createUserWithEmailAndPassword,
  signOut,
  emailKey,
  normalizePhone,
  firebaseErrorMessage
} from "./firebase-wecan.js";

let requestCache = [];
let studentsCache = [];
let requestSearchTerm = "";
let requestStatusFilter = "all";
let requestSortMode = "newest";
let studentSearchTerm = "";
let studentStatusFilter = "all";
let studentSortMode = "newest";
let studentTypeFilter = "all";
let studentGroupFilter = "all";

const DAY = 24 * 60 * 60 * 1000;
const DEFAULT_DURATION_MONTHS = 1;

const AR_MONTHS = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];

function currentCourseGroupName(date = new Date()) {
  return "دورة " + AR_MONTHS[date.getMonth()] + " " + date.getFullYear();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function tsToMs(value) {
  if (value && typeof value.toDate === "function") return value.toDate().getTime();
  if (typeof value === "number") return value;
  return 0;
}

function formatTs(value, createdAtMs) {
  let d = null;
  if (value && typeof value.toDate === "function") d = value.toDate();
  else if (createdAtMs) d = new Date(createdAtMs);
  if (!d || isNaN(d.getTime())) return "";
  return d.getFullYear() + "/" + String(d.getMonth()+1).padStart(2,"0") + "/" + String(d.getDate()).padStart(2,"0") + " " + String(d.getHours()).padStart(2,"0") + ":" + String(d.getMinutes()).padStart(2,"0");
}

function formatDateOnly(ms) {
  const d = new Date(ms);
  if (!ms || isNaN(d.getTime())) return "";
  return d.getFullYear() + "/" + String(d.getMonth()+1).padStart(2,"0") + "/" + String(d.getDate()).padStart(2,"0");
}

function showAdminToast(msg, type) {
  const old = window.showToast;
  if (typeof old === "function") {
    old(msg, type || "ok");
    return;
  }
  alert(msg);
}

function addMonths(baseMs, months) {
  const d = new Date(baseMs || Date.now());
  d.setMonth(d.getMonth() + Number(months || DEFAULT_DURATION_MONTHS));
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

function parseCustomDate(text) {
  const value = String(text || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return 0;
  const d = new Date(value + "T23:59:59");
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

function askExpiryFromDuration(durationValue, baseMs) {
  const dur = String(durationValue || DEFAULT_DURATION_MONTHS);
  if (dur === "custom") {
    const val = prompt("اكتب تاريخ انتهاء الاشتراك بهذا الشكل:\nYYYY-MM-DD\nمثال: 2026-06-05");
    const parsed = parseCustomDate(val);
    if (!parsed) {
      showAdminToast("صيغة التاريخ غير صحيحة. استخدم YYYY-MM-DD", "err");
      return 0;
    }
    return parsed;
  }
  return addMonths(baseMs || Date.now(), Number(dur || DEFAULT_DURATION_MONTHS));
}

function durationSelectHtml(id, defaultValue = "1") {
  return `<select class="duration-select" id="${escapeHtml(id)}" title="مدة الاشتراك">
    <option value="1" ${defaultValue === "1" ? "selected" : ""}>شهر</option>
    <option value="2" ${defaultValue === "2" ? "selected" : ""}>شهرين</option>
    <option value="3" ${defaultValue === "3" ? "selected" : ""}>3 أشهر</option>
    <option value="6" ${defaultValue === "6" ? "selected" : ""}>6 أشهر</option>
    <option value="12" ${defaultValue === "12" ? "selected" : ""}>سنة</option>
    <option value="custom">تاريخ مخصص</option>
  </select>`;
}

function getStudentExpiryMs(st) {
  return Number(st?.subscriptionExpiresAtMs || tsToMs(st?.subscriptionExpiresAt) || 0);
}

function isExpiredByDate(st) {
  const exp = getStudentExpiryMs(st);
  return !!exp && exp < Date.now();
}

function isActiveStudent(st) {
  return st?.isSubscriber === true && !isExpiredByDate(st);
}

function isExpiringSoon(st) {
  const exp = getStudentExpiryMs(st);
  return isActiveStudent(st) && exp > Date.now() && exp <= Date.now() + (7 * DAY);
}

function daysRemaining(st) {
  const exp = getStudentExpiryMs(st);
  if (!exp) return null;
  return Math.ceil((exp - Date.now()) / DAY);
}

function expiryBadgeHtml(st) {
  const exp = getStudentExpiryMs(st);
  if (!exp) return `<span class="student-expiry no-expiry">بدون تاريخ انتهاء</span>`;
  const days = daysRemaining(st);
  if (days < 0) return `<span class="student-expiry expired">انتهى في ${escapeHtml(formatDateOnly(exp))}</span>`;
  if (days <= 7) return `<span class="student-expiry soon">باقي ${days} يوم · ${escapeHtml(formatDateOnly(exp))}</span>`;
  return `<span class="student-expiry active">ينتهي: ${escapeHtml(formatDateOnly(exp))} · باقي ${days} يوم</span>`;
}

function sourceLabel(source) {
  if (source === "manual-admin") return "إضافة يدوية";
  if (source === "subscription-request") return "طلب من الموقع";
  return source ? String(source) : "مشترك";
}

function typeLabel(type) {
  if (type === "course") return "دورة";
  if (type === "trial") return "تجريبي";
  if (type === "free") return "مجاني";
  return type || "";
}

function toWhatsAppNumber(phone) {
  let p = normalizePhone(phone || "");
  if (!p) return "";
  if (p.startsWith("00")) p = p.slice(2);
  if (p.startsWith("0") && p.length === 10) return "966" + p.slice(1);
  if (p.startsWith("5") && p.length === 9) return "966" + p;
  return p;
}

function buildApprovalMessage(student, temporaryPassword, expiryMs) {
  const name = student?.name ? String(student.name).trim() : "";
  const email = student?.email ? String(student.email).trim() : "";
  let msg = "تم قبولك وتفعيل حسابك في منصة WE CAN STEP ✅";
  if (name) msg += "\n\nالاسم: " + name;
  msg += "\n\nرابط الدخول:\nhttps://wecan4step.com/login.html";
  if (email) msg += "\n\nالإيميل:\n" + email;
  if (student?.group) msg += "\n\nالمجموعة / الدورة:\n" + String(student.group).trim();
  if (temporaryPassword) msg += "\n\nكلمة المرور المؤقتة:\n" + temporaryPassword;
  else msg += "\n\nكلمة المرور:\nاستخدم كلمة المرور التي سجلت بها أو التي أُرسلت لك سابقًا.";
  if (expiryMs) msg += "\n\nتاريخ انتهاء الاشتراك:\n" + formatDateOnly(expiryMs);
  msg += "\n\nبعد الدخول بتظهر لك المنصة والدورة مباشرة بإذن الله 🌟";
  return msg;
}

function buildRenewalReminderMessage(student) {
  const name = student?.name ? String(student.name).trim() : "";
  const exp = getStudentExpiryMs(student);
  let msg = "تذكير من منصة WE CAN STEP 🌟";
  if (name) msg += "\n\nأهلًا " + name;
  if (exp && exp >= Date.now()) msg += "\n\nاشتراكك سينتهي قريبًا بتاريخ: " + formatDateOnly(exp);
  else if (exp) msg += "\n\nاشتراكك انتهى بتاريخ: " + formatDateOnly(exp);
  msg += "\n\nإذا ترغب في التجديد، تواصل معنا ونفعّل لك الاشتراك مباشرة بإذن الله ✅";
  msg += "\n\nرابط المنصة:\nhttps://wecan4step.com/login.html";
  return msg;
}

function buildWhatsAppUrl(student, message) {
  const number = toWhatsAppNumber(student?.phone || "");
  const msg = message || buildApprovalMessage(student, "", getStudentExpiryMs(student));
  return number ? ("https://wa.me/" + number + "?text=" + encodeURIComponent(msg)) : ("https://wa.me/?text=" + encodeURIComponent(msg));
}

function buildWhatsAppBusinessIntentUrl(student, message) {
  const number = toWhatsAppNumber(student?.phone || "");
  const msg = message || buildApprovalMessage(student, "", getStudentExpiryMs(student));
  const fallbackUrl = buildWhatsAppUrl(student, msg);
  const query = (number ? ("phone=" + encodeURIComponent(number) + "&") : "") + "text=" + encodeURIComponent(msg);

  // WhatsApp Business package on Android: com.whatsapp.w4b
  // If Business is unavailable, Chrome uses the fallback URL.
  return "intent://send?" + query + "#Intent;scheme=whatsapp;package=com.whatsapp.w4b;S.browser_fallback_url=" + encodeURIComponent(fallbackUrl) + ";end";
}

function openWhatsAppUrlPreferBusiness(student, message) {
  const fallbackUrl = buildWhatsAppUrl(student, message);
  const isAndroid = /Android/i.test(navigator.userAgent || "");

  try {
    if (isAndroid) {
      window.location.href = buildWhatsAppBusinessIntentUrl(student, message);
      return;
    }

    const opened = window.open(fallbackUrl, "_blank", "noopener,noreferrer");
    if (!opened) window.location.href = fallbackUrl;
  } catch (_) {
    window.location.href = fallbackUrl;
  }
}

function openWhatsAppForStudent(student, temporaryPassword, expiryMs) {
  const message = buildApprovalMessage(student, temporaryPassword || "", expiryMs || getStudentExpiryMs(student));
  openWhatsAppUrlPreferBusiness(student, message);
}

function openWhatsAppWithMessage(student, message) {
  openWhatsAppUrlPreferBusiness(student, message);
}

window.openApprovalWhatsapp = function(nameEnc, phoneEnc, emailEnc, passwordEnc, expiryEnc, groupEnc) {
  const student = {
    name: decodeURIComponent(nameEnc || ""),
    phone: decodeURIComponent(phoneEnc || ""),
    email: decodeURIComponent(emailEnc || ""),
    group: decodeURIComponent(groupEnc || "")
  };
  const password = decodeURIComponent(passwordEnc || "");
  const expiryMs = Number(decodeURIComponent(expiryEnc || "0")) || 0;
  openWhatsAppForStudent(student, password, expiryMs);
};

window.openRenewalWhatsapp = function(studentIdEnc) {
  const studentId = decodeURIComponent(studentIdEnc || "");
  const st = studentsCache.find(x => studentDocId(x) === studentId);
  if (!st) return;
  openWhatsAppWithMessage(st, buildRenewalReminderMessage(st));
};

function whatsappButtonHtml(st, password, expiryMs) {
  const name = encodeURIComponent(st?.name || "");
  const phone = encodeURIComponent(st?.phone || "");
  const email = encodeURIComponent(st?.email || "");
  const pass = encodeURIComponent(password || "");
  const exp = encodeURIComponent(String(expiryMs || getStudentExpiryMs(st) || 0));
  const group = encodeURIComponent(st?.group || "");
  return `<button class="act-btn wa-btn" type="button" onclick="openApprovalWhatsapp('${name}','${phone}','${email}','${pass}','${exp}','${group}')">📲 رسالة واتساب</button>`;
}

function studentDocId(st) {
  return st?.id || emailKey(st?.email || "");
}

function studentTime(st) {
  return Math.max(tsToMs(st.updatedAt), tsToMs(st.approvedAt), tsToMs(st.subscriptionEndedAt), tsToMs(st.createdAt), tsToMs(st.lastLoginAt), Number(st.lastLoginAtMs || 0), Number(st.createdAtMs || 0));
}

function injectManualUI() {
  if (document.getElementById("manualFirebaseStyle")) return;
  const style = document.createElement("style");
  style.id = "manualFirebaseStyle";
  style.textContent = `
  .manual-add-card{background:#fff;border:1px solid var(--border);border-radius:18px;padding:18px 20px;box-shadow:0 6px 18px rgba(15,23,42,.06);margin-bottom:24px;display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap}
  .manual-add-card strong{display:block;color:var(--navy);font-size:17px;margin-bottom:4px}.manual-add-card span{color:var(--muted);font-size:13px;font-weight:600}
  .manual-add-btn{border:none;border-radius:13px;padding:12px 18px;font-size:14px;font-weight:900;color:#fff;background:linear-gradient(135deg,var(--navy),#1e4060);box-shadow:0 7px 18px rgba(23,50,68,.20);cursor:pointer}
  .modal-backdrop{position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:1000;display:none;align-items:center;justify-content:center;padding:18px}.modal-backdrop.show{display:flex}
  .modal-card{width:100%;max-width:580px;background:#fff;border-radius:22px;padding:24px;box-shadow:0 24px 70px rgba(0,0,0,.28);border:1px solid var(--border);max-height:92vh;overflow:auto}
  .modal-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:18px}.modal-head h3{font-size:20px;color:var(--navy);font-weight:900}.modal-close{border:none;background:#f1f5f9;border-radius:10px;padding:8px 10px;cursor:pointer;font-size:18px}
  .modal-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.modal-field{margin-bottom:12px}.modal-field.full{grid-column:1/-1}.modal-field label{display:block;font-size:12px;font-weight:800;color:var(--navy);margin-bottom:6px}.modal-field input,.modal-field select,.modal-field textarea{width:100%;border:1.5px solid var(--border);border-radius:12px;padding:11px 12px;font-family:inherit;font-size:14px;outline:none;background:#fff}.modal-field input:focus,.modal-field select:focus,.modal-field textarea:focus{border-color:var(--gold2);box-shadow:0 0 0 4px rgba(251,191,36,.10)}.modal-field input[type=email],.modal-field input[type=tel],.modal-field input[type=password]{direction:ltr;text-align:left}.modal-actions{display:flex;gap:10px;justify-content:flex-start;margin-top:8px}.modal-save{border:none;border-radius:12px;padding:12px 18px;background:linear-gradient(135deg,var(--correct),#15803d);color:#fff;font-weight:900;cursor:pointer}.modal-cancel{border:1.5px solid var(--border);border-radius:12px;padding:12px 18px;background:#fff;color:var(--navy);font-weight:900;cursor:pointer}
  .firebase-error-box{background:#fff5f5;border:1px solid #fecaca;color:#991b1b;border-radius:16px;padding:18px;line-height:1.8;font-weight:700}
  .student-tools{display:flex;align-items:center;gap:10px;margin:0 0 14px;flex-wrap:wrap}
  .student-search{flex:1;min-width:220px;border:1.5px solid var(--border);border-radius:12px;padding:12px 14px;font-family:inherit;font-size:14px;outline:none;background:#fff}
  .student-search:focus{border-color:var(--gold2);box-shadow:0 0 0 4px rgba(251,191,36,.10)}
  .students-panel,.expiring-panel{margin-top:34px;display:none}.students-panel.show,.expiring-panel.show{display:block}
  .student-card{background:#fff;border:1px solid var(--border);border-radius:18px;box-shadow:0 6px 18px rgba(15,23,42,.06);overflow:hidden;margin-bottom:12px;padding:16px 18px}
  .student-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.student-main{flex:1;min-width:0}.student-name{font-size:15px;font-weight:900;color:var(--navy);margin-bottom:5px}.student-meta{display:flex;gap:12px;flex-wrap:wrap}.student-meta span{font-size:12px;color:var(--muted);font-weight:700;direction:ltr}.student-badge{padding:6px 11px;border-radius:999px;font-size:12px;font-weight:900;background:rgba(22,163,74,.10);color:var(--correct);white-space:nowrap}.student-source{padding:6px 11px;border-radius:999px;font-size:12px;font-weight:900;background:rgba(37,99,235,.08);color:#1d4ed8;white-space:nowrap}.student-date{font-size:11px;color:var(--muted);white-space:nowrap}
  .student-expiry{display:inline-flex;align-items:center;padding:6px 11px;border-radius:999px;font-size:12px;font-weight:900;white-space:nowrap}.student-expiry.active{background:rgba(22,163,74,.10);color:var(--correct)}.student-expiry.soon{background:rgba(234,88,12,.10);color:var(--orange)}.student-expiry.expired,.student-expiry.no-expiry{background:rgba(100,116,139,.10);color:var(--muted)}
  .filter-bar{background:#fff;border:1px solid var(--border);border-radius:16px;padding:14px;margin:0 0 16px;display:flex;gap:10px;flex-wrap:wrap;align-items:center;box-shadow:0 6px 18px rgba(15,23,42,.05)}
  .filter-input,.filter-select,.duration-select{border:1.5px solid var(--border);border-radius:12px;padding:11px 12px;font-family:inherit;font-size:13px;background:#fff;color:var(--text);outline:none;min-height:44px}.filter-input{flex:1;min-width:210px}.filter-select{min-width:145px}.duration-select{min-width:120px}.filter-input:focus,.filter-select:focus,.duration-select:focus{border-color:var(--gold2);box-shadow:0 0 0 4px rgba(251,191,36,.10)}
  .wa-btn{background:linear-gradient(135deg,#16a34a,#15803d);color:#fff;box-shadow:0 5px 14px rgba(22,163,74,.22);border:none}.wa-btn:hover{box-shadow:0 8px 20px rgba(22,163,74,.32)}
  .danger-btn{background:#fff;color:#b91c1c;border:2px solid #fecaca;box-shadow:0 4px 10px rgba(15,23,42,.05)}.danger-btn:hover{background:#fff5f5;border-color:#dc2626}
  .reactivate-btn,.renew-btn{background:linear-gradient(135deg,#2563eb,#1d4ed8);color:#fff;box-shadow:0 5px 14px rgba(37,99,235,.22);border:none}.note-btn{background:#fff;color:var(--navy);border:2px solid var(--border)}
  .student-badge.inactive{background:rgba(220,38,38,.08);color:var(--wrong)}.student-badge.soon{background:rgba(234,88,12,.10);color:var(--orange)}
  .student-card.inactive{opacity:.88;border-color:#fecaca;background:#fffafa}.student-card.soon{border-color:#fed7aa;background:#fffaf3}
  .student-note{margin-top:9px;background:#f8fafc;border:1px dashed var(--border);border-radius:12px;padding:9px 11px;color:var(--muted);font-size:12px;font-weight:700;line-height:1.7}
  @media(min-width:701px){.stats-row{grid-template-columns:repeat(5,1fr)}}
  @media(max-width:1100px) and (min-width:701px){.stats-row{grid-template-columns:repeat(3,1fr)}}
  /* Student cards clean layout */
  .student-top{display:flex;align-items:flex-start;gap:12px;margin-bottom:12px}
  .student-avatar{flex:0 0 auto}
  .student-titlebox{flex:1;min-width:0;text-align:right}
  .student-email{margin-top:6px;color:var(--muted);font-size:13px;font-weight:800;word-break:break-all;line-height:1.5;text-align:left;direction:ltr}
  .student-statusbox{display:flex;flex-direction:column;align-items:flex-start;gap:8px;flex:0 0 auto;max-width:180px}
  .student-details{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:8px}
  .student-detail{background:#f8fafc;border:1px solid var(--border);border-radius:14px;padding:10px 12px;min-width:0}
  .student-detail strong{display:block;color:var(--navy);font-size:12px;font-weight:900;margin-bottom:5px}
  .student-detail span{display:block;color:var(--muted);font-size:13px;font-weight:800;line-height:1.55;overflow-wrap:anywhere}
  .student-actions{padding:14px 0 0;margin-top:12px;border-top:1px solid #edf2f7;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
  .student-actions .act-btn{width:100%;justify-content:center;min-height:44px;text-align:center;white-space:normal;line-height:1.35}
  @media(max-width:650px){.modal-grid{grid-template-columns:1fr}.manual-add-card{align-items:flex-start}.manual-add-btn{width:100%}.student-top{display:grid;grid-template-columns:48px 1fr;gap:12px;align-items:start}.student-statusbox{grid-column:1 / -1;max-width:none;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;width:100%}.student-statusbox .student-badge,.student-statusbox .student-expiry{justify-content:center;text-align:center;width:100%}.student-details{grid-template-columns:1fr}.student-actions{grid-template-columns:1fr}.student-email{text-align:right}}
  `;
  document.head.appendChild(style);

  const stats = document.querySelector(".stats-row");
  if (stats && !document.getElementById("manualAddCard")) {
    const card = document.createElement("div");
    card.id = "manualAddCard";
    card.className = "manual-add-card";
    card.innerHTML = `<div><strong>➕ إضافة طالب يدويًا</strong><span>للطلاب اللي يرسلون بياناتهم عبر واتساب بدون ما يظهر طلبهم تلقائيًا.</span></div><div style="display:flex;gap:10px;flex-wrap:wrap"><button class="manual-add-btn" type="button" onclick="openManualStudentModal()">➕ إضافة وتفعيل طالب</button><button class="manual-add-btn" type="button" onclick="showSubscribersPanel()">👥 عرض المشتركين</button><button class="manual-add-btn" type="button" onclick="showExpiringPanel()">⏰ تنتهي قريبًا</button><button class="manual-add-btn" type="button" onclick="exportStudentsCsv()">📥 تصدير CSV</button></div>`;
    stats.insertAdjacentElement("afterend", card);
  }

  if (stats && !document.getElementById("studentsCountCard")) {
    const stat = document.createElement("div");
    stat.id = "studentsCountCard";
    stat.className = "stat-card";
    stat.innerHTML = `<div class="stat-icon si-approved">👥</div><div class="stat-info"><strong class="approved-num" id="studentsCount">0</strong><span>الطلاب المفعّلون</span></div>`;
    stats.appendChild(stat);
  }
  if (stats && !document.getElementById("expiringCountCard")) {
    const stat = document.createElement("div");
    stat.id = "expiringCountCard";
    stat.className = "stat-card";
    stat.innerHTML = `<div class="stat-icon si-pending">⏰</div><div class="stat-info"><strong class="pending-num" id="expiringSoonCount">0</strong><span>تنتهي خلال 7 أيام</span></div>`;
    stats.appendChild(stat);
  }

  const requestsList = document.getElementById("requestsList");
  if (requestsList && !document.getElementById("requestFilterBar")) {
    const bar = document.createElement("div");
    bar.id = "requestFilterBar";
    bar.className = "filter-bar";
    bar.innerHTML = `
      <input class="filter-input" id="requestSearch" type="search" placeholder="ابحث في الطلبات بالاسم أو الإيميل أو الجوال..." oninput="filterRequestsList()">
      <select class="filter-select" id="requestStatusFilter" onchange="filterRequestsList()">
        <option value="all">كل الطلبات</option><option value="pending">قيد الانتظار</option><option value="approved">مقبولة</option><option value="rejected">مرفوضة</option>
      </select>
      <select class="filter-select" id="requestSortMode" onchange="filterRequestsList()">
        <option value="newest">الأحدث أولًا</option><option value="oldest">الأقدم أولًا</option><option value="name-asc">الاسم أ-ي</option><option value="name-desc">الاسم ي-أ</option>
      </select>`;
    requestsList.parentNode.insertBefore(bar, requestsList);
  }
  if (requestsList && !document.getElementById("studentsPanel")) {
    const panel = document.createElement("section");
    panel.id = "studentsPanel";
    panel.className = "students-panel";
    panel.innerHTML = `
      <div class="section-head"><h2>👥 الطلاب المشتركون / المفعّلون</h2><button class="refresh-btn" type="button" onclick="renderStudentsFirebase(true)">🔄 تحديث المشتركين</button></div>
      <div class="student-tools filter-bar">
        <input class="student-search filter-input" id="studentSearch" type="search" placeholder="ابحث بالاسم أو الإيميل أو الجوال أو المجموعة..." oninput="filterStudentsList()">
        <select class="filter-select" id="studentStatusFilter" onchange="filterStudentsList()"><option value="all">كل الطلاب</option><option value="active">المشتركين الفعّالين</option><option value="soon">تنتهي قريبًا</option><option value="inactive">الاشتراكات المنتهية</option></select>
        <select class="filter-select" id="studentTypeFilter" onchange="filterStudentsList()"><option value="all">كل الأنواع</option><option value="course">دورة</option><option value="trial">تجريبي</option><option value="free">مجاني</option></select>
        <select class="filter-select" id="studentGroupFilter" onchange="filterStudentsList()"><option value="all">كل المجموعات</option></select>
        <select class="filter-select" id="studentSortMode" onchange="filterStudentsList()"><option value="newest">الأحدث أولًا</option><option value="oldest">الأقدم أولًا</option><option value="name-asc">الاسم أ-ي</option><option value="name-desc">الاسم ي-أ</option><option value="expiry-asc">الأقرب انتهاءً</option></select>
      </div>
      <div id="studentsList"></div>`;
    requestsList.insertAdjacentElement("afterend", panel);
  }
  if (requestsList && !document.getElementById("expiringPanel")) {
    const panel = document.createElement("section");
    panel.id = "expiringPanel";
    panel.className = "expiring-panel";
    panel.innerHTML = `<div class="section-head"><h2>⏰ اشتراكات تنتهي خلال 7 أيام</h2><button class="refresh-btn" type="button" onclick="showExpiringPanel()">🔄 تحديث</button></div><div id="expiringList"></div>`;
    document.getElementById("studentsPanel")?.insertAdjacentElement("afterend", panel);
  }

  if (!document.getElementById("manualStudentModal")) {
    const modal = document.createElement("div");
    modal.id = "manualStudentModal";
    modal.className = "modal-backdrop";
    modal.innerHTML = `
    <div class="modal-card">
      <div class="modal-head"><h3>➕ إضافة طالب يدويًا</h3><button type="button" class="modal-close" onclick="closeManualStudentModal()">×</button></div>
      <form id="manualStudentForm">
        <div class="modal-grid">
          <div class="modal-field full"><label>الاسم الكامل</label><input id="mName" type="text" required placeholder="مثال: فاطمة سعود عبدالرحمن السعيد"></div>
          <div class="modal-field"><label>الإيميل</label><input id="mEmail" type="email" required placeholder="student@gmail.com"></div>
          <div class="modal-field"><label>الجوال</label><input id="mPhone" type="tel" required maxlength="10" placeholder="05xxxxxxxx"></div>
          <div class="modal-field"><label>كلمة المرور</label><input id="mPassword" type="password" required placeholder="6 أحرف على الأقل"></div>
          <div class="modal-field"><label>نوع الاشتراك</label><select id="mType"><option value="course">دورة</option><option value="trial">تجريبي</option><option value="free">مجاني</option></select></div>
          <div class="modal-field"><label>مدة الاشتراك</label><select id="mDuration"><option value="1">شهر</option><option value="2">شهرين</option><option value="3" selected>3 أشهر</option><option value="6">6 أشهر</option><option value="12">سنة</option><option value="custom">تاريخ مخصص</option></select></div>
          <div class="modal-field full"><label>المجموعة / الدورة</label><input id="mGroup" type="text" placeholder="مثال: دورة مايو 2026"></div>
          <div class="modal-field full"><label>ملاحظات اختيارية</label><textarea id="mNotes" rows="3" placeholder="مثال: تم الدفع عبر واتساب"></textarea></div>
        </div>
        <div class="modal-actions"><button id="mSaveBtn" type="submit" class="modal-save">حفظ وتفعيل ✅</button><button type="button" class="modal-cancel" onclick="closeManualStudentModal()">إلغاء</button></div>
      </form>
    </div>`;
    document.body.appendChild(modal);
  }

  const form = document.getElementById("manualStudentForm");
  if (form && !form.dataset.bound) {
    form.dataset.bound = "1";
    form.addEventListener("submit", addManualStudent);
  }
}

window.openManualStudentModal = function () {
  const modal = document.getElementById("manualStudentModal");
  const groupInput = document.getElementById("mGroup");
  if (groupInput && !groupInput.value.trim()) groupInput.value = currentCourseGroupName();
  modal?.classList.add("show");
};
window.closeManualStudentModal = function () { document.getElementById("manualStudentModal")?.classList.remove("show"); };

async function addManualStudent(e) {
  e.preventDefault();
  const btn = document.getElementById("mSaveBtn");
  const name = document.getElementById("mName").value.trim();
  const email = document.getElementById("mEmail").value.trim().toLowerCase();
  const phone = normalizePhone(document.getElementById("mPhone").value.trim());
  const password = document.getElementById("mPassword").value.trim();
  const type = document.getElementById("mType").value;
  const duration = document.getElementById("mDuration").value;
  const group = document.getElementById("mGroup").value.trim();
  const notes = document.getElementById("mNotes").value.trim();
  const startedMs = Date.now();
  const expiryMs = askExpiryFromDuration(duration, startedMs);

  if (!expiryMs) return;
  if (!name || !email || !/^05\d{8}$/.test(phone) || password.length < 6) {
    showAdminToast("تأكد من الاسم والإيميل والجوال وكلمة المرور.", "err");
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = "جارٍ الحفظ..."; }

  try {
    let uid = "";
    try {
      const cred = await createUserWithEmailAndPassword(secondaryAuth, email, password);
      uid = cred.user.uid;
      await signOut(secondaryAuth);
    } catch (err) {
      if (err && err.code === "auth/email-already-in-use") uid = "";
      else throw err;
    }
    await setDoc(doc(db, "students", emailKey(email)), {
      uid,
      name,
      email,
      phone,
      isSubscriber: true,
      subscriptionStatus: "active",
      subscriptionType: type,
      subscriptionDuration: duration,
      subscriptionStartedAtMs: startedMs,
      subscriptionExpiresAtMs: expiryMs,
      group,
      notes,
      source: "manual-admin",
      approvedAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    }, { merge: true });
    await setDoc(doc(db, "phoneLookup", phone), { email, updatedAt: serverTimestamp() }, { merge: true });
    showAdminToast("تمت إضافة الطالب وتفعيل حسابه بنجاح ✅ وسيتم فتح واتساب برسالة جاهزة.", "ok");
    openWhatsAppForStudent({ name, email, phone, group }, password, expiryMs);
    closeManualStudentModal();
    e.target.reset();
    await renderRequestsFirebase();
    await renderStudentsFirebase(false);
  } catch (err) {
    showAdminToast(firebaseErrorMessage(err), "err");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "حفظ وتفعيل ✅"; }
  }
}

function sortStudents(list) {
  const mode = studentSortMode || "newest";
  return [...list].sort((a,b) => {
    if (mode === "oldest") return studentTime(a) - studentTime(b);
    if (mode === "name-asc") return String(a.name || "").localeCompare(String(b.name || ""), "ar");
    if (mode === "name-desc") return String(b.name || "").localeCompare(String(a.name || ""), "ar");
    if (mode === "expiry-asc") return (getStudentExpiryMs(a) || 9999999999999) - (getStudentExpiryMs(b) || 9999999999999);
    return studentTime(b) - studentTime(a);
  });
}

function getFilteredStudents() {
  const input = document.getElementById("studentSearch");
  const statusEl = document.getElementById("studentStatusFilter");
  const typeEl = document.getElementById("studentTypeFilter");
  const groupEl = document.getElementById("studentGroupFilter");
  const sortEl = document.getElementById("studentSortMode");
  studentSearchTerm = String(input?.value || studentSearchTerm || "").trim().toLowerCase();
  studentStatusFilter = String(statusEl?.value || studentStatusFilter || "all");
  studentTypeFilter = String(typeEl?.value || studentTypeFilter || "all");
  studentGroupFilter = String(groupEl?.value || studentGroupFilter || "all");
  studentSortMode = String(sortEl?.value || studentSortMode || "newest");
  const list = studentsCache.filter(st => {
    const active = isActiveStudent(st);
    if (studentStatusFilter === "active" && !active) return false;
    if (studentStatusFilter === "inactive" && active) return false;
    if (studentStatusFilter === "soon" && !isExpiringSoon(st)) return false;
    if (studentTypeFilter !== "all" && String(st.subscriptionType || "") !== studentTypeFilter) return false;
    if (studentGroupFilter !== "all" && String(st.group || "") !== studentGroupFilter) return false;
    if (!studentSearchTerm) return true;
    return [st.name, st.email, st.phone, st.subscriptionType, st.source, st.group, st.notes].some(v => String(v || "").toLowerCase().includes(studentSearchTerm));
  });
  return sortStudents(list);
}

async function loadStudents() {
  const snap = await getDocs(collection(db, "students"));
  studentsCache = [];
  snap.forEach(d => studentsCache.push({ id: d.id, ...d.data() }));
  studentsCache = sortStudents(studentsCache);
  return studentsCache;
}

function updateStudentCounters() {
  const activeCount = studentsCache.filter(isActiveStudent).length;
  const soonCount = studentsCache.filter(isExpiringSoon).length;
  const countEl = document.getElementById("studentsCount");
  const soonEl = document.getElementById("expiringSoonCount");
  if (countEl) countEl.textContent = String(activeCount || 0);
  if (soonEl) soonEl.textContent = String(soonCount || 0);
}

function updateStudentGroupOptions() {
  const select = document.getElementById("studentGroupFilter");
  if (!select) return;
  const current = select.value || studentGroupFilter || "all";
  const groups = [...new Set(studentsCache.map(st => String(st.group || "").trim()).filter(Boolean))].sort((a,b) => b.localeCompare(a, "ar"));
  select.innerHTML = `<option value="all">كل المجموعات</option>` + groups.map(g => `<option value="${escapeHtml(g)}">${escapeHtml(g)}</option>`).join("");
  if (["all", ...groups].includes(current)) select.value = current;
}

function renderStudentCards(list, targetId = "studentsList") {
  updateStudentCounters();
  const wrap = document.getElementById(targetId);
  if (!wrap) return;
  const students = list || getFilteredStudents();
  if (!students.length) {
    wrap.innerHTML = '<div class="empty-state"><div class="empty-icon">👥</div><p>لا توجد نتائج مطابقة</p></div>';
    return;
  }
  wrap.innerHTML = students.map(st => {
    const isActive = isActiveStudent(st);
    const soon = isExpiringSoon(st);
    const active = isActive ? "مشترك فعّال" : "اشتراك منتهي";
    const safeId = encodeURIComponent(studentDocId(st));
    const type = typeLabel(st.subscriptionType);
    const lastLogin = st.lastLoginAt || st.lastLoginAtMs ? formatTs(st.lastLoginAt, st.lastLoginAtMs) : "لم يسجل بعد";
    const group = st.group ? `<span>🗂️ ${escapeHtml(st.group)}</span>` : "";
    const note = st.notes ? `<div class="student-note">📝 ${escapeHtml(st.notes)}</div>` : "";
    const actions = isActive
      ? `${whatsappButtonHtml(st)}<button class="act-btn wa-btn" type="button" onclick="openRenewalWhatsapp('${safeId}')">📩 تذكير التجديد</button><button class="act-btn renew-btn" type="button" onclick="renewStudentSubscription('${safeId}',1)">🔁 تجديد شهر</button><button class="act-btn renew-btn" type="button" onclick="renewStudentSubscription('${safeId}',3)">🔁 تجديد 3 أشهر</button><button class="act-btn renew-btn" type="button" onclick="renewStudentSubscription('${safeId}','custom')">📅 تجديد مخصص</button><button class="act-btn note-btn" type="button" onclick="editStudentGroup('${safeId}')">🗂️ المجموعة</button><button class="act-btn note-btn" type="button" onclick="editStudentNotes('${safeId}')">📝 ملاحظات</button><button class="act-btn danger-btn" type="button" onclick="endStudentSubscription('${safeId}')">🔴 إنهاء الاشتراك</button>`
      : `<button class="act-btn reactivate-btn" type="button" onclick="reactivateStudentSubscription('${safeId}')">✅ إعادة التفعيل</button><button class="act-btn renew-btn" type="button" onclick="renewStudentSubscription('${safeId}',1)">🔁 تجديد شهر</button><button class="act-btn note-btn" type="button" onclick="editStudentGroup('${safeId}')">🗂️ المجموعة</button><button class="act-btn note-btn" type="button" onclick="editStudentNotes('${safeId}')">📝 ملاحظات</button>`;
    const updatedDate = formatTs(st.updatedAt || st.approvedAt || st.subscriptionEndedAt, st.createdAtMs);
    const groupText = st.group ? escapeHtml(st.group) : "بدون مجموعة";
    return `<div class="student-card ${isActive ? (soon ? "soon" : "") : "inactive"}">
      <div class="student-top">
        <div class="req-avatar student-avatar">👤</div>
        <div class="student-titlebox">
          <div class="student-name">${escapeHtml(st.name || "بدون اسم")}</div>
          <div class="student-email" dir="ltr">${escapeHtml(st.email || "")}</div>
        </div>
        <div class="student-statusbox">
          <span class="student-badge ${isActive ? (soon ? "soon" : "") : "inactive"}">${isActive ? (soon ? "⏰" : "✅") : "🔴"} ${active}</span>
          ${expiryBadgeHtml(st)}
        </div>
      </div>

      <div class="student-details">
        <div class="student-detail"><strong>📱 الجوال</strong><span dir="ltr">${escapeHtml(st.phone || "")}</span></div>
        <div class="student-detail"><strong>🎓 النوع</strong><span>${escapeHtml(type || "غير محدد")}</span></div>
        <div class="student-detail"><strong>🗂️ المجموعة</strong><span>${groupText}</span></div>
        <div class="student-detail"><strong>🕘 آخر دخول</strong><span>${escapeHtml(lastLogin)}</span></div>
        <div class="student-detail"><strong>📌 المصدر</strong><span>${escapeHtml(sourceLabel(st.source))}</span></div>
        <div class="student-detail"><strong>📅 آخر تحديث</strong><span>${updatedDate}</span></div>
      </div>

      ${note}
      <div class="student-actions">${actions}</div>
    </div>`;
  }).join("");
}

window.renderStudentsFirebase = async function(showPanel = true) {
  const panel = document.getElementById("studentsPanel");
  const wrap = document.getElementById("studentsList");
  if (showPanel && panel) panel.classList.add("show");
  try {
    if (wrap && (showPanel || panel?.classList.contains("show"))) wrap.innerHTML = '<div class="empty-state"><div class="empty-icon">⏳</div><p>جارٍ تحميل الطلاب المشتركين...</p></div>';
    await loadStudents();
    updateStudentGroupOptions();
    if (showPanel || panel?.classList.contains("show")) renderStudentCards(getFilteredStudents());
    else updateStudentCounters();
  } catch (err) {
    if (wrap && (showPanel || panel?.classList.contains("show"))) wrap.innerHTML = '<div class="firebase-error-box">تعذر تحميل الطلاب المشتركين.<br><small>' + escapeHtml(firebaseErrorMessage(err)) + '</small></div>';
  }
};

window.showSubscribersPanel = async function() {
  document.getElementById("studentsPanel")?.classList.add("show");
  await window.renderStudentsFirebase(true);
  document.getElementById("studentsPanel")?.scrollIntoView({ behavior: "smooth", block: "start" });
};

window.showExpiringPanel = async function() {
  const panel = document.getElementById("expiringPanel");
  const wrap = document.getElementById("expiringList");
  if (panel) panel.classList.add("show");
  if (wrap) wrap.innerHTML = '<div class="empty-state"><div class="empty-icon">⏳</div><p>جارٍ تحميل الاشتراكات القريبة من الانتهاء...</p></div>';
  await loadStudents();
  renderStudentCards(sortStudents(studentsCache.filter(isExpiringSoon)), "expiringList");
  panel?.scrollIntoView({ behavior: "smooth", block: "start" });
};

window.filterStudentsList = function() { renderStudentCards(getFilteredStudents()); };

window.endStudentSubscription = async function(studentIdEnc) {
  const studentId = decodeURIComponent(studentIdEnc || "");
  const st = studentsCache.find(x => studentDocId(x) === studentId);
  if (!st) return;
  if (!confirm("هل تريد إنهاء اشتراك هذا الطالب؟\n\n" + (st.name || st.email || "طالب"))) return;
  try {
    await updateDoc(doc(db, "students", studentId), {
      isSubscriber: false,
      subscriptionStatus: "ended",
      subscriptionEndedAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    showAdminToast("تم إنهاء الاشتراك بنجاح 🔴", "ok");
    await renderStudentsFirebase(true);
    await renderRequestsFirebase();
  } catch (err) { showAdminToast(firebaseErrorMessage(err), "err"); }
};

window.reactivateStudentSubscription = async function(studentIdEnc) {
  const studentId = decodeURIComponent(studentIdEnc || "");
  const st = studentsCache.find(x => studentDocId(x) === studentId);
  if (!st) return;
  const expiryMs = askExpiryFromDuration("1", Date.now());
  if (!expiryMs) return;
  try {
    await updateDoc(doc(db, "students", studentId), {
      isSubscriber: true,
      subscriptionStatus: "active",
      subscriptionStartedAtMs: Date.now(),
      subscriptionExpiresAtMs: expiryMs,
      reactivatedAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    showAdminToast("تمت إعادة تفعيل الاشتراك ✅", "ok");
    await renderStudentsFirebase(true);
    await renderRequestsFirebase();
  } catch (err) { showAdminToast(firebaseErrorMessage(err), "err"); }
};

window.renewStudentSubscription = async function(studentIdEnc, months) {
  const studentId = decodeURIComponent(studentIdEnc || "");
  const st = studentsCache.find(x => studentDocId(x) === studentId);
  if (!st) return;
  const currentExp = getStudentExpiryMs(st);
  const baseMs = currentExp && currentExp > Date.now() ? currentExp : Date.now();
  const expiryMs = askExpiryFromDuration(String(months), baseMs);
  if (!expiryMs) return;
  try {
    await updateDoc(doc(db, "students", studentId), {
      isSubscriber: true,
      subscriptionStatus: "active",
      subscriptionExpiresAtMs: expiryMs,
      renewedAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    showAdminToast("تم تجديد الاشتراك حتى " + formatDateOnly(expiryMs) + " ✅", "ok");
    await renderStudentsFirebase(true);
  } catch (err) { showAdminToast(firebaseErrorMessage(err), "err"); }
};

window.editStudentGroup = async function(studentIdEnc) {
  const studentId = decodeURIComponent(studentIdEnc || "");
  const st = studentsCache.find(x => studentDocId(x) === studentId);
  if (!st) return;
  const group = prompt("اكتب اسم المجموعة / الدورة:", st.group || currentCourseGroupName());
  if (group === null) return;
  try {
    await updateDoc(doc(db, "students", studentId), { group: group.trim(), updatedAt: serverTimestamp() });
    showAdminToast("تم تحديث المجموعة / الدورة 🗂️", "ok");
    await renderStudentsFirebase(true);
  } catch (err) { showAdminToast(firebaseErrorMessage(err), "err"); }
};

window.editStudentNotes = async function(studentIdEnc) {
  const studentId = decodeURIComponent(studentIdEnc || "");
  const st = studentsCache.find(x => studentDocId(x) === studentId);
  if (!st) return;
  const notes = prompt("اكتب الملاحظات الداخلية لهذا الطالب:", st.notes || "");
  if (notes === null) return;
  try {
    await updateDoc(doc(db, "students", studentId), { notes: notes.trim(), updatedAt: serverTimestamp() });
    showAdminToast("تم حفظ الملاحظات 📝", "ok");
    await renderStudentsFirebase(true);
  } catch (err) { showAdminToast(firebaseErrorMessage(err), "err"); }
};

window.exportStudentsCsv = async function() {
  try {
    if (!studentsCache.length) await loadStudents();
    const headers = ["name","email","phone","status","subscriptionType","group","expiresAt","daysRemaining","source","lastLogin","notes"];
    const rows = studentsCache.map(st => {
      const exp = getStudentExpiryMs(st);
      const vals = [
        st.name || "", st.email || "", st.phone || "", isActiveStudent(st) ? "active" : "inactive",
        typeLabel(st.subscriptionType), st.group || "", exp ? formatDateOnly(exp) : "", daysRemaining(st) ?? "",
        sourceLabel(st.source), (st.lastLoginAt || st.lastLoginAtMs ? formatTs(st.lastLoginAt, st.lastLoginAtMs) : ""), st.notes || ""
      ];
      return vals.map(v => '"' + String(v).replace(/"/g, '""') + '"').join(",");
    });
    const csv = "\ufeff" + headers.join(",") + "\n" + rows.join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "wecan-students-" + new Date().toISOString().slice(0,10) + ".csv";
    document.body.appendChild(a); a.click(); a.remove();
    showAdminToast("تم تجهيز ملف CSV ✅", "ok");
  } catch (err) { showAdminToast(firebaseErrorMessage(err), "err"); }
};

async function loadRequests() {
  const q = query(collection(db, "subscriptionRequests"), orderBy("createdAt", "desc"));
  const snap = await getDocs(q);
  requestCache = [];
  snap.forEach(d => requestCache.push({ id: d.id, ...d.data() }));
  return requestCache;
}

function requestTime(req) { return Math.max(tsToMs(req.createdAt), tsToMs(req.approvedAt), tsToMs(req.rejectedAt), Number(req.createdAtMs || 0)); }

function getFilteredRequests() {
  const searchEl = document.getElementById("requestSearch");
  const statusEl = document.getElementById("requestStatusFilter");
  const sortEl = document.getElementById("requestSortMode");
  requestSearchTerm = String(searchEl?.value || requestSearchTerm || "").trim().toLowerCase();
  requestStatusFilter = String(statusEl?.value || requestStatusFilter || "all");
  requestSortMode = String(sortEl?.value || requestSortMode || "newest");
  const list = requestCache.filter(req => {
    if (requestStatusFilter !== "all" && req.status !== requestStatusFilter) return false;
    if (!requestSearchTerm) return true;
    return [req.name, req.email, req.phone, req.status, req.group].some(v => String(v || "").toLowerCase().includes(requestSearchTerm));
  });
  list.sort((a,b) => {
    if (requestSortMode === "oldest") return requestTime(a) - requestTime(b);
    if (requestSortMode === "name-asc") return String(a.name || "").localeCompare(String(b.name || ""), "ar");
    if (requestSortMode === "name-desc") return String(b.name || "").localeCompare(String(a.name || ""), "ar");
    return requestTime(b) - requestTime(a);
  });
  return list;
}
window.filterRequestsList = function() { renderRequestCards(getFilteredRequests()); };

function renderRequestCards(all) {
  const sourceForCounts = requestCache.length ? requestCache : all;
  const pending = sourceForCounts.filter(r => r.status === "pending").length;
  const approved = sourceForCounts.filter(r => r.status === "approved").length;
  const rejected = sourceForCounts.filter(r => r.status === "rejected").length;
  const p = document.getElementById("pendingCount"), a = document.getElementById("approvedCount"), rj = document.getElementById("rejectedCount");
  if (p) p.textContent = pending;
  if (a) a.textContent = approved;
  if (rj) rj.textContent = rejected;
  const wrap = document.getElementById("requestsList");
  if (!wrap) return;
  if (all.length === 0) {
    wrap.innerHTML = '<div class="empty-state"><div class="empty-icon">📭</div><p>لا توجد طلبات مطابقة للفلترة الحالية</p></div>';
    return;
  }
  const statusLabel = { pending: "قيد الانتظار", approved: "مقبول", rejected: "مرفوض" };
  const statusClass = { pending: "status-pending", approved: "status-approved", rejected: "status-rejected" };
  wrap.innerHTML = all.map(req => {
    let actionsHtml = "";
    const durId = "duration-" + req.id;
    if (req.status === "pending") {
      const groupId = "group-" + req.id;
      actionsHtml = `${durationSelectHtml(durId, "1")}<input class="filter-input approval-group-input" id="${groupId}" type="text" placeholder="المجموعة / الدورة" value="${escapeHtml(req.group || currentCourseGroupName())}"><button class="act-btn approve-btn" onclick="approveReqFirebase('${req.id}')">✅ قبول</button><button class="act-btn reject-btn" onclick="rejectReqFirebase('${req.id}')">❌ رفض</button>`;
    } else if (req.status === "approved") {
      actionsHtml = '<span style="color:var(--correct);font-weight:800;font-size:13px">✅ تم القبول والتفعيل</span>' + whatsappButtonHtml(req, "", Number(req.subscriptionExpiresAtMs || 0));
    } else {
      actionsHtml = '<span style="color:var(--wrong);font-weight:800;font-size:13px">❌ تم الرفض</span>';
    }
    return `<div class="req-card">
      <div class="req-card-head"><div class="req-avatar">👤</div><div class="req-info"><div class="req-name">${escapeHtml(req.name)}</div><div class="req-meta"><span>📱 ${escapeHtml(req.phone)}</span><span>✉️ ${escapeHtml(req.email)}</span>${req.group ? `<span>🗂️ ${escapeHtml(req.group)}</span>` : ""}</div></div><span class="req-status ${statusClass[req.status] || "status-pending"}">${statusLabel[req.status] || "قيد الانتظار"}</span><span class="req-time">${formatTs(req.createdAt, req.createdAtMs)}</span></div>
      <div class="req-actions" style="flex-wrap:wrap">${actionsHtml}</div>
    </div>`;
  }).join("");
}

async function renderRequestsFirebase() {
  const wrap = document.getElementById("requestsList");
  try {
    if (wrap) wrap.innerHTML = '<div class="empty-state"><div class="empty-icon">⏳</div><p>جارٍ تحميل طلبات Firebase...</p></div>';
    await loadRequests();
    renderRequestCards(getFilteredRequests());
    await renderStudentsFirebase(false);
  } catch (err) {
    if (wrap) wrap.innerHTML = '<div class="firebase-error-box">تعذر تحميل طلبات Firebase.<br>تأكد من تفعيل Firestore، وتسجيل الدخول كأدمن، ولصق القواعد الصحيحة.<br><small>' + escapeHtml(firebaseErrorMessage(err)) + '</small></div>';
  }
}
window.renderRequests = renderRequestsFirebase;

window.approveReqFirebase = async function (id) {
  const req = requestCache.find(r => r.id === id);
  if (!req || req.status !== "pending") return;
  const durationEl = document.getElementById("duration-" + id);
  const duration = durationEl ? durationEl.value : String(DEFAULT_DURATION_MONTHS);
  const groupEl = document.getElementById("group-" + id);
  const group = String(groupEl?.value || currentCourseGroupName()).trim();
  const startedMs = Date.now();
  const expiryMs = askExpiryFromDuration(duration, startedMs);
  if (!expiryMs) return;
  try {
    const email = String(req.email || "").trim().toLowerCase();
    const phone = normalizePhone(req.phone || "");
    await setDoc(doc(db, "students", emailKey(email)), {
      uid: req.uid || "",
      name: req.name || "",
      email,
      phone,
      isSubscriber: true,
      subscriptionStatus: "active",
      subscriptionType: "course",
      subscriptionDuration: duration,
      subscriptionStartedAtMs: startedMs,
      subscriptionExpiresAtMs: expiryMs,
      group,
      source: "subscription-request",
      approvedAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    }, { merge: true });
    if (phone) await setDoc(doc(db, "phoneLookup", phone), { email, updatedAt: serverTimestamp() }, { merge: true });
    await updateDoc(doc(db, "subscriptionRequests", id), { status: "approved", approvedAt: serverTimestamp(), subscriptionExpiresAtMs: expiryMs, group });
    showAdminToast("تم قبول طلب " + (req.name || "الطالب") + " وتفعيل اشتراكه ✅ وسيتم فتح واتساب برسالة جاهزة.", "ok");
    openWhatsAppForStudent({ name: req.name || "", email, phone, group }, "", expiryMs);
    await renderRequestsFirebase();
    await renderStudentsFirebase(false);
  } catch (err) { showAdminToast(firebaseErrorMessage(err), "err"); }
};

window.rejectReqFirebase = async function (id) {
  const req = requestCache.find(r => r.id === id);
  if (!req || req.status !== "pending") return;
  try {
    await updateDoc(doc(db, "subscriptionRequests", id), { status: "rejected", rejectedAt: serverTimestamp() });
    showAdminToast("تم رفض طلب " + (req.name || "الطالب") + " ❌", "err");
    await renderRequestsFirebase();
    await renderStudentsFirebase(false);
  } catch (err) { showAdminToast(firebaseErrorMessage(err), "err"); }
};

function redirectToLogin() {
  try { localStorage.removeItem("isAdmin"); } catch(e) {}
  window.location.replace("./login.html?next=admin.html");
}

window.addEventListener("DOMContentLoaded", function () {
  onAuthStateChanged(auth, function(user) {
    const email = user && user.email ? String(user.email).toLowerCase() : "";
    if (!user || email !== ADMIN_EMAIL) {
      redirectToLogin();
      return;
    }
    document.documentElement.classList.remove("admin-auth-loading");
    injectManualUI();
    renderRequestsFirebase();
  }, function() { redirectToLogin(); });
});
