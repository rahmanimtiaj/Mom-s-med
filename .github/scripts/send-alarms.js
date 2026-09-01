// Runs every 5 minutes via .github/workflows/medicine-alarm.yml.
// Reads the shared JSONBin store, works out which doses are due right now
// (in the family's timezone), and sends a Web Push notification to every
// subscribed device. Re-sends every 5 minutes for anything still not given,
// and stops on its own once the dose is logged as given in the app.

const webpush = require('web-push');

const JSONBIN_ID = process.env.JSONBIN_ID;
const JSONBIN_KEY = process.env.JSONBIN_KEY;
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const TIMEZONE = process.env.TIMEZONE || 'Asia/Dhaka';
const JSONBIN_BASE = 'https://api.jsonbin.io/v3/b/' + JSONBIN_ID;

const STALE_MINUTES = 12 * 60;      // ignore doses more than 12h overdue (don't resurrect old misses)
const RESEND_MS = 5 * 60 * 1000 - 30 * 1000; // re-notify every ~5 min, with a small buffer

webpush.setVapidDetails('mailto:alerts@momscare.app', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

function fmtTime(t) {
  const [h, m] = t.split(':').map(Number);
  const ap = h >= 12 ? 'PM' : 'AM';
  let hh = h % 12; if (hh === 0) hh = 12;
  return hh + ':' + String(m).padStart(2, '0') + ' ' + ap;
}

// Computes "now" in the given IANA timezone without relying on the runner's
// own local timezone (GitHub Actions runners are UTC).
function getLocalParts(tz) {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map(p => [p.type, p.value]));
  return {
    dateStr: `${parts.year}-${parts.month}-${parts.day}`,
    minutesOfDay: Number(parts.hour) * 60 + Number(parts.minute)
  };
}

async function fetchBin() {
  const res = await fetch(JSONBIN_BASE + '/latest', { headers: { 'X-Master-Key': JSONBIN_KEY } });
  if (!res.ok) throw new Error('GET ' + res.status + ': ' + (await res.text()));
  const json = await res.json();
  const record = json.record || {};
  return {
    medications: record.medications || {},
    doseLogs: record.doseLogs || {},
    glucoseReadings: record.glucoseReadings || {},
    bpReadings: record.bpReadings || {},
    careEvents: record.careEvents || {},
    pushSubscriptions: record.pushSubscriptions || [],
    alarmNotifyLog: record.alarmNotifyLog || {}
  };
}

async function pushBin(fullObj) {
  const res = await fetch(JSONBIN_BASE, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Master-Key': JSONBIN_KEY, 'X-Bin-Versioning': 'false' },
    body: JSON.stringify(fullObj)
  });
  if (!res.ok) throw new Error('PUT ' + res.status + ': ' + (await res.text()));
}

async function main() {
  if (!JSONBIN_ID || !JSONBIN_KEY || !VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    throw new Error('Missing one of JSONBIN_ID / JSONBIN_KEY / VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY secrets.');
  }

  const state = await fetchBin();
  const { dateStr, minutesOfDay } = getLocalParts(TIMEZONE);
  const nowMs = Date.now();

  const due = [];
  let logChanged = false;
  Object.values(state.medications).forEach(med => {
    (med.schedule || []).forEach(sched => {
      const key = dateStr + '_' + med.id + '_' + sched.id;
      if (state.doseLogs[key]) {
        if (state.alarmNotifyLog[key]) { delete state.alarmNotifyLog[key]; logChanged = true; }
        return; // already given
      }
      const [h, m] = (sched.time || '00:00').split(':').map(Number);
      const schedMinutes = h * 60 + m;
      const diff = minutesOfDay - schedMinutes;
      if (diff < 0 || diff > STALE_MINUTES) return; // not due yet, or too stale
      const lastSent = state.alarmNotifyLog[key];
      if (lastSent && (nowMs - lastSent) < RESEND_MS) return; // notified recently, wait for the 5-min cycle
      due.push({ key, med, sched });
    });
  });

  // Housekeeping: drop notify-log entries from days that have passed.
  Object.keys(state.alarmNotifyLog).forEach(key => {
    if (!key.startsWith(dateStr)) { delete state.alarmNotifyLog[key]; logChanged = true; }
  });

  if (due.length === 0) {
    console.log('Nothing due right now.');
    if (logChanged) await pushBin(state);
    return;
  }

  const title = due.length === 1 ? "It's medicine time" : `${due.length} medicines due`;
  const body = due.map(d => `${d.med.name}${d.sched.time ? ' · ' + fmtTime(d.sched.time) : ''}`).join('\n');
  const payload = JSON.stringify({ title, body, tag: 'momscare-alarm', url: './' });

  const stillValidSubs = [];
  for (const sub of state.pushSubscriptions) {
    try {
      await webpush.sendNotification(sub, payload);
      stillValidSubs.push(sub);
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        console.log('Dropping an expired subscription.');
      } else {
        console.error('Push send failed:', err.statusCode, err.body);
        stillValidSubs.push(sub); // keep it — might just be a transient error
      }
    }
  }
  state.pushSubscriptions = stillValidSubs;
  due.forEach(d => { state.alarmNotifyLog[d.key] = nowMs; });

  await pushBin(state);
  console.log(`Notified ${stillValidSubs.length} device(s) about ${due.length} due dose(s).`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
