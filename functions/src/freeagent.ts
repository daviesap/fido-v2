import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";

export const FREEAGENT_API_ORIGIN = "https://api.freeagent.com";
export const FREEAGENT_REDIRECT_URI = "https://fido.flair.london/oauth/freeagent/callback";
export const FREEAGENT_APP_ORIGIN = "https://fido.flair.london";
export const FREEAGENT_USER_AGENT = "Fido Receipt Manager (https://fido.flair.london)";

const TokenResponseSchema = z.object({
  access_token: z.string().min(1).max(4096),
  refresh_token: z.string().min(1).max(4096),
  token_type: z.string().min(1).max(40),
  expires_in: z.number().int().positive().max(86_400),
  refresh_token_expires_in: z.number().int().positive().optional(),
});

const OAuthErrorResponseSchema = z.object({
  error: z.enum([
    "invalid_request",
    "invalid_client",
    "invalid_grant",
    "unauthorized_client",
    "unsupported_grant_type",
    "invalid_scope",
  ]),
});

const UserResponseSchema = z.object({
  user: z.object({
    url: z.string().url(),
    first_name: z.string().max(160),
    last_name: z.string().max(160),
    email: z.string().email(),
    role: z.string().max(80),
    permission_level: z.number().int().min(0).max(8),
  }),
});

const CompanyResponseSchema = z.object({
  company: z.object({
    url: z.string().url(),
    id: z.union([z.string(), z.number()]).transform(String),
    name: z.string().min(1).max(240),
    subdomain: z.string().min(1).max(160),
    type: z.string().min(1).max(80),
    currency: z.string().regex(/^[A-Z]{3}$/),
  }),
});

export type FreeAgentTokens = z.infer<typeof TokenResponseSchema>;
export type FreeAgentIdentity = ReturnType<typeof parseIdentity>;

export type EncryptedSecret = {
  version: 1;
  iv: string;
  tag: string;
  ciphertext: string;
};

export function buildFreeAgentAuthorizationUrl(input: { clientId: string; state: string }): string {
  const url = new URL("/v2/approve_app", FREEAGENT_API_ORIGIN);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", FREEAGENT_REDIRECT_URI);
  url.searchParams.set("state", input.state);
  return url.toString();
}

export async function exchangeFreeAgentCode(input: {
  clientId: string;
  clientSecret: string;
  code: string;
  fetchImpl?: typeof fetch;
}): Promise<FreeAgentTokens> {
  return requestTokens({
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: FREEAGENT_REDIRECT_URI,
    }),
    fetchImpl: input.fetchImpl,
  });
}

export async function refreshFreeAgentTokens(input: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  fetchImpl?: typeof fetch;
}): Promise<FreeAgentTokens> {
  return requestTokens({
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
    }),
    fetchImpl: input.fetchImpl,
  });
}

export async function fetchFreeAgentIdentity(accessToken: string, fetchImpl: typeof fetch = fetch): Promise<FreeAgentIdentity> {
  const [userJson, companyJson] = await Promise.all([
    freeAgentGet("/v2/users/me", accessToken, fetchImpl),
    freeAgentGet("/v2/company", accessToken, fetchImpl),
  ]);
  return parseIdentity(userJson, companyJson);
}

export function encryptSecret(value: string, encodedKey: string): EncryptedSecret {
  const key = encryptionKey(encodedKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return {
    version: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

export function decryptSecret(value: EncryptedSecret, encodedKey: string): string {
  if (value.version !== 1) throw new Error("unsupported_encryption_version");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(encodedKey), Buffer.from(value.iv, "base64"));
  decipher.setAuthTag(Buffer.from(value.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(value.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

async function requestTokens(input: {
  clientId: string;
  clientSecret: string;
  body: URLSearchParams;
  fetchImpl?: typeof fetch;
}): Promise<FreeAgentTokens> {
  const response = await (input.fetchImpl ?? fetch)(`${FREEAGENT_API_ORIGIN}/v2/token_endpoint`, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Basic ${Buffer.from(`${input.clientId}:${input.clientSecret}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": FREEAGENT_USER_AGENT,
    },
    body: input.body.toString(),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const parsedError = OAuthErrorResponseSchema.safeParse(await response.json().catch(() => null));
    const code = parsedError.success ? `token_${parsedError.data.error}` : "token_request_failed";
    throw new FreeAgentRequestError(code, response.status);
  }
  const parsed = TokenResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new FreeAgentRequestError("invalid_token_response", response.status);
  return parsed.data;
}

async function freeAgentGet(path: string, accessToken: string, fetchImpl: typeof fetch): Promise<unknown> {
  const response = await fetchImpl(`${FREEAGENT_API_ORIGIN}${path}`, {
    method: "GET",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${accessToken}`,
      "user-agent": FREEAGENT_USER_AGENT,
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new FreeAgentRequestError("api_request_failed", response.status);
  return response.json();
}

function parseIdentity(userJson: unknown, companyJson: unknown) {
  const user = UserResponseSchema.parse(userJson).user;
  const company = CompanyResponseSchema.parse(companyJson).company;
  return {
    user: {
      url: user.url,
      firstName: user.first_name,
      lastName: user.last_name,
      email: user.email,
      role: user.role,
      permissionLevel: user.permission_level,
    },
    company: {
      url: company.url,
      id: company.id,
      name: company.name,
      subdomain: company.subdomain,
      type: company.type,
      currency: company.currency,
    },
  };
}

function encryptionKey(encodedKey: string): Buffer {
  const key = Buffer.from(encodedKey.trim(), "base64");
  if (key.length !== 32) throw new Error("invalid_encryption_key");
  return key;
}

export class FreeAgentRequestError extends Error {
  constructor(public readonly code: string, public readonly status: number) {
    super(code);
  }
}
