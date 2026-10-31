'use strict';
/**
 * Microsoft / Xbox Live / Minecraft authentication.
 *
 * Uses the OAuth 2.0 device-code flow against the official Microsoft endpoint
 * with the public Minecraft launcher client id. The user never types a password
 * into VOID Client: they open microsoft.com/link on any device and enter a code.
 *
 * Chain: MSA token -> Xbox Live (XBL) -> XSTS -> Minecraft services -> profile.
 */

const CLIENT_ID = '00000000402b5328'; // public Minecraft launcher client id
const SCOPE = 'service::user.auth.xboxlive.com::MBI_SSL';
const DEVICE_CODE_URL = 'https://login.live.com/oauth20_connect.srf';
const TOKEN_URL = 'https://login.live.com/oauth20_token.srf';

async function postForm(url, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Auth endpoint returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
  return { status: res.status, json };
}

async function postJson(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${url} returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const e = new Error(json.error_description || json.errorMessage || `HTTP ${res.status}`);
    e.xboxError = json.XErr;
    e.status = res.status;
    throw e;
  }
  return json;
}

/** Step 1 — request a device code. Returns {user_code, verification_uri, device_code, interval, expires_in}. */
async function requestDeviceCode() {
  const { status, json } = await postForm(DEVICE_CODE_URL, {
    client_id: CLIENT_ID,
    scope: SCOPE,
    response_type: 'device_code',
  });
  if (status !== 200 || !json.device_code) {
    throw new Error(json.error_description || `Device code request failed (HTTP ${status})`);
  }
  return {
    deviceCode: json.device_code,
    userCode: json.user_code,
    verificationUri: json.verification_uri,
    interval: (json.interval || 5) * 1000,
    expiresIn: json.expires_in,
  };
}

/** Step 2 — poll until the user approves. Returns {accessToken, refreshToken, expiresAt}. */
async function pollForToken(deviceCode, intervalMs, timeoutMs, onTick) {
  const deadline = Date.now() + timeoutMs;
  let wait = intervalMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, wait));
    if (onTick) onTick(Math.max(0, Math.round((deadline - Date.now()) / 1000)));
    const { status, json } = await postForm(TOKEN_URL, {
      client_id: CLIENT_ID,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: deviceCode,
    });
    if (status === 200 && json.access_token) {
      return {
        accessToken: json.access_token,
        refreshToken: json.refresh_token,
        expiresAt: Date.now() + (json.expires_in || 86400) * 1000,
      };
    }
    if (json.error === 'authorization_pending') continue;
    if (json.error === 'slow_down') {
      wait += 5000;
      continue;
    }
    if (json.error === 'expired_token') throw new Error('Device code expired — start sign-in again.');
    if (json.error === 'authorization_declined') throw new Error('Sign-in was declined.');
    throw new Error(json.error_description || json.error || 'Sign-in failed.');
  }
  throw new Error('Timed out waiting for Microsoft sign-in.');
}

/** Refresh an expired MSA token. */
async function refreshMsa(refreshToken) {
  const { status, json } = await postForm(TOKEN_URL, {
    client_id: CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: SCOPE,
  });
  if (status !== 200 || !json.access_token) {
    throw new Error(json.error_description || 'Token refresh failed — sign in again.');
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: Date.now() + (json.expires_in || 86400) * 1000,
  };
}

/** MSA access token -> Xbox Live user token. */
async function xblAuthenticate(msaToken) {
  const r = await postJson('https://user.auth.xboxlive.com/user/authenticate', {
    Properties: {
      AuthMethod: 'RPS',
      SiteName: 'user.auth.xboxlive.com',
      RpsTicket: `d=${msaToken}`,
    },
    RelyingParty: 'http://auth.xboxlive.com',
    TokenType: 'JWT',
  });
  return { token: r.Token, userHash: r.DisplayClaims.xui[0].uhs };
}

/** XBL token -> XSTS token for relying party rp://api.minecraftservices.com/. */
async function xstsAuthorize(xblToken) {
  const r = await postJson('https://xsts.auth.xboxlive.com/xsts/authorize', {
    Properties: { SandboxId: 'RETAIL', UserTokens: [xblToken] },
    RelyingParty: 'rp://api.minecraftservices.com/',
    TokenType: 'JWT',
  });
  return { token: r.Token, userHash: r.DisplayClaims.xui[0].uhs };
}

/** XSTS token -> Minecraft access token. */
async function minecraftLogin(xsts, userHash) {
  const r = await postJson('https://api.minecraftservices.com/authentication/login_with_xbox', {
    identityToken: `XBL3.0 x=${userHash};${xsts}`,
  });
  if (!r.access_token) throw new Error('Minecraft login did not return an access token.');
  return { accessToken: r.access_token, expiresAt: Date.now() + (r.expires_in || 86400) * 1000 };
}

/** Check ownership + fetch the profile (name / uuid / skins). */
async function fetchProfile(mcToken) {
  const res = await fetch('https://api.minecraftservices.com/minecraft/profile', {
    headers: { Authorization: `Bearer ${mcToken}` },
  });
  if (res.status === 404) {
    throw new Error('This Microsoft account does not own Minecraft Java Edition.');
  }
  if (!res.ok) {
    throw new Error(`Profile request failed (HTTP ${res.status}).`);
  }
  const p = await res.json();
  return {
    id: p.id,
    name: p.name,
    skins: p.skins || [],
    capes: p.capes || [],
  };
}

/**
 * Full chain from an MSA token. Returns everything the launch needs.
 */
async function completeChain(msa) {
  const xbl = await xblAuthenticate(msa.accessToken);
  let xsts;
  try {
    xsts = await xstsAuthorize(xbl.token);
  } catch (e) {
    // Friendly mapping for the common XSTS failures.
    if (e.xboxError === 2148916233) {
      throw new Error('This Microsoft account has no Xbox profile. Create one at xbox.com, then retry.');
    }
    if (e.xboxError === 2148916238) {
      throw new Error('This is a child account and must be added to a family group by an adult.');
    }
    if (e.xboxError === 2148916235) {
      throw new Error('Xbox Live is not available in this account\'s country.');
    }
    throw e;
  }
  const mc = await minecraftLogin(xsts.token, xsts.userHash);
  const profile = await fetchProfile(mc.accessToken);
  return { msa, mc, profile };
}

module.exports = {
  CLIENT_ID,
  requestDeviceCode,
  pollForToken,
  refreshMsa,
  completeChain,
  fetchProfile,
};
