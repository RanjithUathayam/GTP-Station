const https = require('https');

const SAP_HOST = 'bbsapserver';
const SAP_PORT = 2096;
const SAP_CREDS = {
    CompanyDB: 'BBLive',
    Password:  'Sap@56gh',
    UserName:  'sapadmin',
};

// ── In-memory token cache ─────────────────────────────────────
let _session    = null;  // { b1session, routeid }
let _sessionExp = 0;     // epoch-ms expiry

// ── Low-level HTTPS request (self-signed cert allowed) ────────
function httpsRequest(method, path, bodyObj, cookieStr) {
    return new Promise((resolve, reject) => {
        const bodyStr = bodyObj ? JSON.stringify(bodyObj) : '';
        const headers = {
            'Content-Type':   'application/json',
            'Content-Length': Buffer.byteLength(bodyStr),
        };
        if (cookieStr) headers['Cookie'] = cookieStr;

        const req = https.request(
            {
                hostname:             SAP_HOST,
                port:                 SAP_PORT,
                path,
                method,
                headers,
                rejectUnauthorized:   false,   // SAP B1 uses self-signed cert
            },
            (res) => {
                let data = '';
                res.on('data', chunk => (data += chunk));
                res.on('end', () =>
                    resolve({ status: res.statusCode, headers: res.headers, body: data })
                );
            }
        );
        req.on('error', reject);
        if (bodyStr) req.write(bodyStr);
        req.end();
    });
}

// ── Parse Set-Cookie array → { NAME: value } ─────────────────
function parseCookies(setCookieHeaders) {
    const map = {};
    for (const hdr of setCookieHeaders || []) {
        const pair = hdr.split(';')[0].trim();
        const eqIdx = pair.indexOf('=');
        if (eqIdx > 0) {
            const name  = pair.slice(0, eqIdx).trim();
            const value = pair.slice(eqIdx + 1).trim();
            map[name] = value;
        }
    }
    return map;
}

// ── Login and cache the SAP B1 session ───────────────────────
async function login() {
    const res = await httpsRequest('POST', '/b1s/v2/Login', SAP_CREDS);

    if (res.status !== 200) {
        throw new Error(`SAP Login failed [${res.status}]: ${res.body}`);
    }

    const cookies = parseCookies(res.headers['set-cookie']);
    const b1session = cookies['B1SESSION'];
    const routeid   = cookies['ROUTEID'] || '';

    if (!b1session) {
        throw new Error('SAP Login: B1SESSION cookie missing in response');
    }

    _session    = { b1session, routeid };
    _sessionExp = Date.now() + 25 * 60 * 1000; // cache 25 min (SAP default 30 min)

    console.log('✅ SAP B1 session obtained');
    return _session;
}

// ── Get (or refresh) the cached session ──────────────────────
async function getSession() {
    if (_session && Date.now() < _sessionExp) return _session;
    return login();
}

// ── Create a Delivery Note in SAP B1 ─────────────────────────
async function createDelivery(payload) {
    let session = await getSession();
    let cookieStr = `B1SESSION=${session.b1session}; ROUTEID=${session.routeid}`;

    let res = await httpsRequest('POST', '/b1s/v1/DeliveryNotes', payload, cookieStr);

    // Session may have expired on the server — re-login once and retry
    if (res.status === 401 || res.status === 403) {
        console.warn('⚠️  SAP session expired — re-logging in…');
        _session    = null;
        _sessionExp = 0;
        session    = await getSession();
        cookieStr  = `B1SESSION=${session.b1session}; ROUTEID=${session.routeid}`;
        res        = await httpsRequest('POST', '/b1s/v1/DeliveryNotes', payload, cookieStr);
    }

    if (res.status < 200 || res.status >= 300) {
        let errMsg = res.body;
        try {
            const parsed = JSON.parse(res.body);
            errMsg = parsed?.error?.message?.value || parsed?.message || res.body;
        } catch (_) {}
        throw new Error(`SAP Delivery API [${res.status}]: ${errMsg}`);
    }

    return JSON.parse(res.body);
}

module.exports = { createDelivery, getSession };
