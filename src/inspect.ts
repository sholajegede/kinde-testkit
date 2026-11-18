import { createRemoteJWKSet, decodeJwt, decodeProtectedHeader, jwtVerify, type JWTPayload, type ProtectedHeaderParameters } from "jose";

export type CheckStatus = "pass" | "warn" | "fail";

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface TokenInspection {
  kind: "access" | "id" | "m2m" | "unknown";
  header: ProtectedHeaderParameters | null;
  payload: JWTPayload | null;
  checks: Check[];
}

export async function inspectToken(
  token: string,
  options: { issuerUrl?: string; now?: number } = {},
): Promise<TokenInspection> {
  const checks: Check[] = [];
  const trimmed = token.trim();
  let header: ProtectedHeaderParameters | null = null;
  let payload: JWTPayload | null = null;

  if (trimmed.split(".").length !== 3) {
    checks.push({ name: "Format", status: "fail", detail: "A JWT has three parts separated by dots." });
    return { kind: "unknown", header, payload, checks };
  }
  try {
    header = decodeProtectedHeader(trimmed);
    payload = decodeJwt(trimmed);
  } catch {
    checks.push({ name: "Format", status: "fail", detail: "The header or payload is not valid base64url JSON." });
    return { kind: "unknown", header, payload, checks };
  }
  checks.push({ name: "Format", status: "pass", detail: "Three base64url parts with JSON header and payload." });

  checks.push(
    header.alg === "RS256"
      ? { name: "Algorithm", status: "pass", detail: "RS256, the algorithm Kinde signs with." }
      : { name: "Algorithm", status: "fail", detail: `${String(header.alg)} is not RS256. Kinde tokens are always RS256.` },
  );

  const signer = typeof header.kid === "string" && header.kid.startsWith("kinde-testkit") ? "kinde-testkit" : "another issuer";
  checks.push({ name: "Key", status: "pass", detail: `kid ${String(header.kid ?? "missing")} (${signer}).` });

  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number") {
    checks.push({ name: "Expiry", status: "fail", detail: "No exp claim." });
  } else if (payload.exp <= now) {
    checks.push({ name: "Expiry", status: "fail", detail: `Expired ${formatSpan(now - payload.exp)} ago.` });
  } else {
    checks.push({ name: "Expiry", status: "pass", detail: `Expires in ${formatSpan(payload.exp - now)}.` });
  }
  if (typeof payload.iat === "number" && payload.iat > now + 60) {
    checks.push({ name: "Issued at", status: "fail", detail: `iat is ${formatSpan(payload.iat - now)} in the future.` });
  }

  if (options.issuerUrl) {
    const issuer = options.issuerUrl.replace(/\/+$/, "");
    if (payload.iss !== issuer) {
      checks.push({ name: "Issuer", status: "fail", detail: `iss is ${String(payload.iss)}, not ${issuer}.` });
    } else {
      checks.push({ name: "Issuer", status: "pass", detail: `Issued by ${issuer}.` });
    }
    try {
      await jwtVerify(trimmed, createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`)), { algorithms: ["RS256"] });
      checks.push({ name: "Signature", status: "pass", detail: `Verified against ${issuer}/.well-known/jwks.json.` });
    } catch (error) {
      const code = (error as { code?: string }).code ?? "";
      if (code === "ERR_JWT_EXPIRED" || code === "ERR_JWT_CLAIM_VALIDATION_FAILED") {
        checks.push({ name: "Signature", status: "pass", detail: `Verified against ${issuer}/.well-known/jwks.json.` });
      } else {
        checks.push({ name: "Signature", status: "fail", detail: describeVerifyError(code, issuer) });
      }
    }
  } else {
    checks.push({ name: "Signature", status: "warn", detail: "Not checked. Pass --url to verify against a running issuer." });
  }

  return { kind: kindOf(payload), header, payload, checks };
}

function kindOf(payload: JWTPayload): TokenInspection["kind"] {
  if (Array.isArray(payload.gty) && payload.gty.includes("client_credentials")) return "m2m";
  if ("email" in payload || "org_codes" in payload || "at_hash" in payload || "nonce" in payload) return "id";
  if ("scp" in payload || "permissions" in payload || "org_code" in payload) return "access";
  return "unknown";
}

function describeVerifyError(code: string, issuer: string): string {
  if (code === "ERR_JWKS_NO_MATCHING_KEY") return `No key in ${issuer}'s JWKS matches this token's kid.`;
  if (code === "ERR_JWS_SIGNATURE_VERIFICATION_FAILED") return "The signature does not match the token. It was changed after signing.";
  if (code === "ERR_JOSE_ALG_NOT_ALLOWED" || code === "ERR_JOSE_NOT_SUPPORTED") return "The token is not signed with RS256.";
  if (code === "ERR_JWKS_TIMEOUT" || code === "ERR_JOSE_GENERIC") return `Could not fetch keys from ${issuer}.`;
  return `Verification failed (${code || "unknown error"}).`;
}

export function formatSpan(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}
